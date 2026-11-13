// models.maxAtOnce in what a person reads: a held task's row, its card in its chat, and the reply a task add or a tell
// gets (LiveSource's heldWords). Its agents are stubbed at the status only: this machine's one spark agent is at work,
// and nothing is started in herdr.
import { afterAll, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('model-cap-words')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
delete process.env.SHEPHERDR_MAIN
const { LiveSource } = await import('../server/live/source.ts')
const { placeId } = await import('../server/live/places.ts')

const src = new LiveSource()
src.engine.installed = () => true
src.settings.set('machine.startEvery', '0', 'machine')
afterAll(() => src.stop())

const SPARK = 'spark/qwen3.8-flash-next-mlx4-mtp-tensorfold'
const REPO = 'git init -q -b main && git config user.email t@t && git config user.name T && echo hi > README.md && git add -A && git commit -qm init'

/** the cards a chat holds, as their words */
const cards = (key: string) => src.chats.chat(key).messages.filter((m) => m.card).map((m) => m.card!.text)

describe("a model's cap in words: the row, the card and the replies name the entry that holds the task", () => {
  test('a harness in a chain is named as the chain names it, never by its model key', async () => {
    const { chainWords } = await import('../server/live/restart.ts')
    // Codex with no model is its default, not openai/unknown; pi names its model in words
    expect(chainWords({ kind: 'codex' })).toBe('Codex (default)')
    expect(chainWords({ kind: 'codex', model: 'default' })).toBe('Codex (default)')
    expect(chainWords({ kind: 'pi', model: SPARK })).toBe(`pi · ${SPARK}`)
  })

  test('a task held by a provider at its cap reads so in its row, its card and the add and tell replies', async () => {
    const dir = tmp('model-cap-repo')
    execSync(REPO, { cwd: dir, shell: '/bin/sh' })
    const p = await src.places.add(dir, 'words-spark')
    const chat = placeId.space(p.name)
    expect(src.settings.set('models.maxAtOnce', 'spark=1', 'machine').ok).toBe(true)
    // no backup takes the task: its words are about the held row alone (the backups' own start is in engine-model-cap)
    expect(src.settings.set('task.fallback', 'off', 'machine').ok).toBe(true)
    // one spark agent of this machine is at work
    const busy = src.engine.tasks.push({ id: 'WRD-1', n: 1, project: chat, base: 'main', title: 'Busy', desc: 'Add b.txt.', by: 'test', created: Date.now(), updated: Date.now(), told: 'work', agent: { kind: 'pi', model: SPARK } } as never)
    void busy
    const key = 'WRD-1/Agent'
    src.agents.records[key] = { key, name: 'WRD-1', kind: 'pi', model: SPARK, cwd: dir, logs: [], started: Date.now() } as never
    const status = src.agents.status
    src.agents.status = ((k: string) => (k === key ? 'working' : status.call(src.agents, k))) as never
    try {
      const add = await src.cli(['task', 'add', 'Second', '--desc', 'Add s.txt.', '--agent', 'pi', '--model', SPARK, '--space', p.name], { chat })
      const id = add.out.match(/([A-Z]+-\d+)/)![1]
      const t = src.engine.task(id)!
      expect(t.held?.why).toBe('model')
      expect(src.engine.subOf(t)).toBe('Waiting: spark 1/1')
      expect(add.out).toContain('held: pi · spark/qwen3.8-flash-next-mlx4-mtp-tensorfold (1 of 1 at once) — every model it may use is full or out')
      expect(cards(`${id}/Agent`)).toContain('waiting: pi · spark/qwen3.8-flash-next-mlx4-mtp-tensorfold (1 of 1 at once) — every model it may use is full or out')
      // a tell to the held task is held the same way, its reply says why, and its words wait with it
      const tell = await src.cli(['task', 'tell', id, 'Go when you can.'], { chat })
      expect(tell.out).toContain(`${id} is held: pi · spark/qwen3.8-flash-next-mlx4-mtp-tensorfold (1 of 1 at once) — every model it may use is full or out`)
    } finally {
      src.agents.status = status
      src.settings.set('models.maxAtOnce', null, 'machine')
    }
  })
})

describe('models.maxAtOnce from the command line: set, show, unset', () => {
  test('shepherdr set takes the list at this machine, shows it as kept, refuses a bad entry, and unset takes it back', async () => {
    const set = await src.cli(['set', 'models.maxAtOnce', 'Spark=4, radeon=1', '--machine'], {})
    expect(set.code).toBe(0)
    expect(src.settings.maxAtOnce()).toEqual([{ pattern: 'spark', max: 4 }, { pattern: 'radeon', max: 1 }])
    expect((await src.cli(['show'], {})).out).toMatch(/^models\.maxAtOnce\s+spark=4, radeon=1\s+\(.+\)$/m)
    const bad = await src.cli(['set', 'models.maxAtOnce', 'spark=0', '--machine'], {})
    expect(bad.code).toBe(1)
    expect(bad.out).toContain('spark needs a whole number from 1 to 200')
    expect(src.settings.maxAtOnce()).toHaveLength(2)
    expect((await src.cli(['unset', 'models.maxAtOnce', '--machine'], {})).code).toBe(0)
    expect(src.settings.maxAtOnce()).toEqual([])
  })
})
