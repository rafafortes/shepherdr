// The help page split into topics (UXD-02): a bare `shepherdr help` still prints the whole page, while
// `shepherdr help <topic>` and `shepherdr <verb> --help` print one section. The sections live in args.ts, so the
// tests import them directly and check the command against them through a LiveSource with no herdr in reach.
import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

const home = tmp('cli-help')
process.env.SHEPHERDR_HOME = home
process.env.HERDR_SOCKET_PATH = join(home, 'no-herdr.sock')
delete process.env.SHEPHERDR_MAIN
const { LiveSource } = await import('../server/live/source.ts')
const { HELP, TOPIC, VERBS, VERB_TOPIC, helpTopic, helpVerb } = await import('../server/live/args.ts')

const src = new LiveSource()
afterAll(() => src.stop())

const cli = async (args: string[]) => src.cli(args, {})

describe('shepherdr help, per topic', () => {
  test('a bare help prints the whole page, and the page is the join of every section', async () => {
    expect((await cli(['help'])).out).toBe(HELP)
    expect((await cli(['--help'])).out).toBe(HELP)
    const page = `shepherdr: talk to Shepherdr from a terminal (agents use it; so can you)\n\n${[TOPIC.spaces, TOPIC.tasks, TOPIC.agents, TOPIC.chat, TOPIC.secrets, TOPIC.artifacts, TOPIC.settings, TOPIC.setup].join('\n')}`
    expect(HELP).toBe(page)
    expect(Object.values(TOPIC).every((section) => section.length < HELP.length)).toBe(true)
  })

  test('a verb’s --help prints only that verb’s section', async () => {
    const tasks = await cli(['task', 'add', '--help'])
    expect(tasks.out).toBe(TOPIC.tasks)
    expect(tasks.out).toContain('shepherdr task add')
    expect(tasks.out).not.toContain('shepherdr secret run')
    // every verb the CLI takes has a section, and its --help opens exactly that section
    for (const verb of VERBS) expect((await cli([verb, '--help'])).out).toBe(TOPIC[VERB_TOPIC[verb]])
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
    expect(helpTopic('tasks')).toBe(TOPIC.tasks)
    expect(helpTopic()).toBe(HELP)
  })

  test('every verb has a topic, and an unknown verb keeps its old refusal', async () => {
    expect(VERBS).toContain('project') // the old alias
    expect(VERBS).toContain('done') // ready's old name
    expect(VERBS).toContain('render') // the gone verb that points at artifacts
    for (const verb of VERBS) {
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
