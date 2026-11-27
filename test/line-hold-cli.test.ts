// shepherdr line, line hold and line release as the human and a coordinator run them, and as a task's agent may not
// (cli-commands.ts lineCommand). A source of its own, so nothing here shifts the other CLI tests' timing.
import { afterAll, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('line-hold-cli')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
delete process.env.SHEPHERDR_MAIN
const { LiveSource } = await import('../server/live/source.ts')
const { placeId } = await import('../server/live/places.ts')

const src = new LiveSource()
afterAll(() => src.stop())
const REPO = 'git init -q -b main && git config user.email t@t && git config user.name T && echo hi > README.md && git add -A && git commit -qm init'
/** what the command printed, without the line end the CLI adds */
const cli = async (args: string[], ctx: Record<string, unknown> = {}) => {
  const r = await src.cli(args, ctx)
  return { ...r, out: r.out.trimEnd() }
}

async function space(name: string) {
  const dir = tmp('line-hold-cli-repo')
  execSync(REPO, { cwd: dir, shell: '/bin/sh' })
  const p = await src.places.add(dir, name)
  return { p, dir, tip: execSync('git rev-parse main', { cwd: dir, shell: '/bin/sh' }).toString().trim() }
}

describe('shepherdr line hold, release and the line', () => {
  test('a hold on an idle line says how long, until when, the base tip, and what to do; the line shows it; a release ends it; releasing again is fine', async () => {
    const { p, tip } = await space('line-cli-a')
    expect((await cli(['line', p.name])).out).toBe(`${p.name} (main): merge line\n  running: nothing\n  waiting: nobody\n  held: no`)
    const hold = await cli(['line', 'hold', p.name, '--why', 'land the hotfix by hand'])
    expect(hold.code).toBe(0)
    expect(hold.out.split('\n')).toEqual([
      expect.stringMatching(new RegExp(`^Held ${p.name}'s merge line for 20 minutes, until \\d\\d:\\d\\d\\.$`)),
      `main is at ${tip}: nothing lands in it until you release the line, and no merge starts its turn (no gate, no train, no landing); merges asked for meanwhile queue in order.`,
      expect.stringMatching(new RegExp(`^Gate and land your commit by hand, then shepherdr line release ${p.name}\\. The hold ends by itself at \\d\\d:\\d\\d\\.$`)),
    ])
    // the line, asked for by name and from a coordinator's own chat, says who holds and why
    const shown = (await cli(['line', p.name])).out
    expect(shown).toMatch(new RegExp(`^${p.name} \\(main\\): merge line\\n  running: nothing\\n  waiting: nobody\\n  held: by you \\(terminal\\) until \\d\\d:\\d\\d: land the hotfix by hand$`))
    expect((await cli(['line'], { chat: placeId.space(p.name) })).out).toBe(shown)
    // a second hold says who holds, and fails
    const again = await cli(['line', 'hold', p.name, '--why', 'me too'])
    expect(again.code).toBe(1)
    expect(again.out).toContain(`${p.name}'s merge line is already held by you (terminal)`)
    const released = await cli(['line', 'release', p.name])
    expect(released.code).toBe(0)
    expect(released.out).toBe(`Released ${p.name}'s merge line (held by you (terminal): land the hotfix by hand). The next merge in line takes its turn now.`)
    const none = await cli(['line', 'release', p.name])
    expect(none.code).toBe(0)
    expect(none.out).toBe(`${p.name}'s merge line is not held: nothing to release.`)
  })

  test('--for is minutes, at most 60 (and says so); a coordinator holds in its own name; a hold asked for with a bad number or no reason is refused', async () => {
    const { p } = await space('line-cli-b')
    const hold = await cli(['line', 'hold', p.name, '--for', '90', '--why', 'a long one'], { chat: placeId.space(p.name) })
    expect(hold.code).toBe(0)
    expect(hold.out).toMatch(new RegExp(`^Held ${p.name}'s merge line for 60 minutes \\(the most a hold lasts\\), until \\d\\d:\\d\\d\\.`))
    expect(src.engine.line(p).hold?.by).toBe(`${p.name}'s coordinator`)
    expect((await cli(['line', 'release', p.name], { chat: placeId.space(p.name) })).out).toContain('Released')
    expect((await cli(['line', 'hold', p.name, '--for', '1.5', '--why', 'x'])).out).toContain('for 1.5 minutes')
    await cli(['line', 'release', p.name])
    for (const [args, says] of [
      [['line', 'hold', p.name, '--for', 'soon', '--why', 'x'], '--for takes a number of minutes'],
      [['line', 'hold', p.name, '--for', '0', '--why', 'x'], '--for takes a number of minutes'],
      [['line', 'hold', p.name, '--wait', 'long', '--why', 'x'], '--wait takes a number of minutes'],
      [['line', 'hold', p.name], 'Say why the merge line is held'],
      [['line', 'hold', '--why', 'x'], 'shepherdr line hold <space>'],
      [['line', 'release'], 'shepherdr line release <space>'],
    ] as [string[], string][]) {
      const r = await cli(args)
      expect(r.code).toBe(1)
      expect(r.out).toContain(says)
    }
    expect(src.engine.line(p).hold).toBeUndefined()
  })

  test("a task's agent is refused: it neither holds nor releases the line, though it may read it; a space that is not there is named", async () => {
    const { p } = await space('line-cli-c')
    const t = src.engine.add({ project: p.name, title: 'A task', by: 'test' })
    const chat = `${t.id}/Agent`
    for (const args of [
      ['line', 'hold', p.name, '--why', 'x'],
      ['line', 'release', p.name],
    ]) {
      const r = await cli(args, { chat })
      expect(r.code).toBe(1)
      expect(r.out).toContain(`A task's agent doesn't ${args[1]} the merge line: its coordinator or the human does.`)
    }
    expect(src.engine.line(p).hold).toBeUndefined()
    // a hold the human took is still the human's: the agent cannot release it, and can read that it is held
    await cli(['line', 'hold', p.name, '--why', 'human'])
    expect((await cli(['line', 'release', p.name], { chat })).code).toBe(1)
    expect((await cli(['line'], { chat })).out).toContain('held: by you (terminal)')
    await cli(['line', 'release', p.name])
    const missing = await cli(['line', 'hold', 'no-such-space', '--why', 'x'])
    expect(missing.code).toBe(1)
    expect(missing.out).toContain('No space called no-such-space')
  })

  test('with no space named and none to infer, every space with something going on is shown; with nothing, one line says so', async () => {
    const { p } = await space('line-cli-d')
    await space('line-cli-e')
    expect((await cli(['line'])).out).toBe('No merge is running or waiting in any space, and no merge line is held.')
    await cli(['line', 'hold', p.name, '--why', 'quiet hold'])
    const all = (await cli(['line'])).out
    expect(all).toContain(`${p.name} (main): merge line`)
    expect(all).not.toContain('line-cli-e')
    await cli(['line', 'release', p.name])
  })

  test('line help is in the help page, under tasks, and the verb is one the command knows', async () => {
    const help = (await cli(['help', 'line'])).out
    expect(help).toContain('shepherdr line hold <space> [--for <minutes>] --why "<text>"')
    expect(help).toContain('shepherdr line release <space>')
    expect((await cli(['line', '--help'])).out).toBe(help)
  })
})
