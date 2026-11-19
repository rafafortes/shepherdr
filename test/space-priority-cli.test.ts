// space.priority as the human sees it in the CLI: shepherdr space list shows this machine's spaces in queue order, and
// shepherdr status says the order in one line only when a space has a number. A source of its own, so nothing here
// shifts the other CLI tests' timing.
import { afterAll, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('space-priority-cli')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
delete process.env.SHEPHERDR_MAIN
const { LiveSource } = await import('../server/live/source.ts')

const src = new LiveSource()
afterAll(() => src.stop())
const REPO = 'git init -q -b main && git config user.email t@t && git config user.name T && echo hi > README.md && git add -A && git commit -qm init'

describe('the order between spaces in shepherdr space list and status', () => {
  test('space list shows the spaces in queue order; status says the order in one line only when one is set', async () => {
    const dirA = tmp('prio-cli-a')
    const dirB = tmp('prio-cli-b')
    execSync(REPO, { cwd: dirA, shell: '/bin/sh' })
    execSync(REPO, { cwd: dirB, shell: '/bin/sh' })
    const a = await src.places.add(dirA, 'prio-space-a')
    const b = await src.places.add(dirB, 'prio-space-b')
    expect((await src.cli(['status'], {})).out).not.toContain('Space order here')
    expect(src.settings.set('space.priority', '2', { space: a.name }).ok).toBe(true)
    expect(src.settings.set('space.priority', '1', { space: b.name }).ok).toBe(true)
    const listed = (await src.cli(['space', 'list'], {})).out.split('\n').filter((l) => l.startsWith('prio-space-')).map((l) => l.split('  ')[0])
    expect(listed).toEqual(['prio-space-b', 'prio-space-a'])
    expect((await src.cli(['status'], {})).out).toContain(`Space order here: ${b.name} (1) · ${a.name} (2); spaces with no priority come after.`)
    // shepherdr unset clears a space's own value; with no numbers left, status says nothing about the order
    expect((await src.cli(['unset', 'space.priority', '--space', a.name], {})).out).toContain('space.priority')
    await src.cli(['unset', 'space.priority', '--space', b.name], {})
    expect((await src.cli(['status'], {})).out).not.toContain('Space order here')
  })

  test('the home space has no place in the queue, and set says why', async () => {
    // home holds no repo, so no task starts in it: a number there would decide nothing, and is refused rather than kept
    const r = await src.cli(['set', 'space.priority', '1', '--space', 'home'], {})
    expect(r.code).toBe(1)
    expect(r.out).toContain('The home space holds no repo, so no task starts in it')
    expect(src.settings.spacePriority('~')).toBeNull()
  })
})
