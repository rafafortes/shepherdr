// Coverage for the corners of the CLI verb surface moved out of source.ts into cli-commands.ts (SHE-160). The broader
// verb answers are pinned in source.test.ts and the other command tests; these are the paths no other file reaches.
import { afterAll, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

const home = tmp('cli-commands-coverage')
process.env.SHEPHERDR_HOME = home
process.env.HERDR_SOCKET_PATH = join(home, 'no-herdr.sock')
delete process.env.SHEPHERDR_MAIN

const { LiveSource } = await import('../server/live/source.ts')
const { placeId } = await import('../server/live/places.ts')

const src = new LiveSource()
afterAll(() => src.stop())

const REPO = 'git init -q -b main && git config user.email t@t && git config user.name T && echo hi > README.md && git add -A && git commit -qm init'
async function space(name: string) {
  const dir = tmp('cli-place')
  execSync(REPO, { cwd: dir, shell: '/bin/sh' })
  const p = await src.places.add(dir, name)
  return { p, dir, place: placeId.space(p.name) }
}
const cli = (args: string[], ctx: Record<string, unknown> = {}) => src.cli(args, ctx)

describe('the moved CLI paths the other command tests do not reach', () => {
  test('an automation add without its name says what it takes', async () => {
    const { p } = await space('cmd-auto')
    expect((await cli(['automation', 'add', '--task', 'Probe', '--when', 'FREQ=DAILY', '--space', p.name])).out).toContain('shepherdr automation add "<name>"')
  })

  test('heartbeat with no place named falls back to one on this machine, and a run that queues says so', async () => {
    const { p } = await space('cmd-heartbeat')
    // two spaces now, so the "only space" shortcut cannot answer: the home/place fallback in the command does
    expect((await cli(['heartbeat'], {})).out).toContain('HEARTBEAT.md')
    const wake = src.wake
    src.wake = () => ({ name: p.name, queued: true })
    try {
      expect((await cli(['heartbeat', 'run', p.name], {})).out).toContain('is busy: it wakes once its turn is over')
    } finally {
      src.wake = wake
    }
  })

  test('secret list reads its chain from a task chat and from a folder', async () => {
    const { p, place, dir } = await space('cmd-secrets')
    const t = src.engine.add({ project: p.name, title: 'Secret chain probe', by: 'test' })
    expect((await cli(['secret', 'list'], { chat: `${t.id}/Agent` })).out).toContain('No secrets here yet')
    expect((await cli(['secret', 'list'], { cwd: dir })).out).toContain('No secrets here yet')
    expect(place).toBeTruthy()
  })

  test('attach refuses a file over the size cap and names every mix of pictures and videos', async () => {
    const dir = tmp('cli-attach')
    const chat = placeId.home()
    const big = join(dir, 'big.png')
    writeFileSync(big, '')
    truncateSync(big, 101 * 1024 * 1024)
    expect((await cli(['attach', big], { chat })).out).toContain('the chat takes a picture or a video up to')
    const pic = join(dir, 'a.png')
    const pic2 = join(dir, 'b.png')
    const video = join(dir, 'a.mp4')
    const video2 = join(dir, 'b.mp4')
    for (const f of [pic, pic2, video, video2]) writeFileSync(f, 'x')
    expect((await cli(['attach', video], { chat })).out).toContain('Posted a video')
    expect((await cli(['attach', pic, pic2], { chat })).out).toContain('Posted 2 pictures')
    expect((await cli(['attach', video, video2], { chat })).out).toContain('Posted 2 videos')
    expect((await cli(['attach', pic, video], { chat })).out).toContain('Posted 2 files (1 picture, 1 video)')
  })

  test('task queue says what an agent waits for and what a held task waits for', async () => {
    const { p } = await space('cmd-queue')
    const t = src.engine.add({ project: p.name, title: 'Queue reply probe', by: 'test' })
    const queue = src.engine.queue
    src.engine.queue = (() => ({ queued: ['X-1'], went: false })) as never
    try {
      expect((await cli(['task', 'queue', t.id, '--after', 'X-1'], { chat: `${t.id}/Agent` })).out).toContain('Stop at a clean point')
    } finally {
      src.engine.queue = queue
    }
    t.held = { why: 'slots', since: Date.now() }
    src.engine.queue = (() => ({ queued: [], went: true })) as never
    try {
      expect((await cli(['task', 'queue', t.id, '--after', 'none'], {})).out).toContain('waits for no task now, but is held')
    } finally {
      src.engine.queue = queue
      t.held = undefined
    }
  })

  test('a model with no effort levels says so when one is asked for', async () => {
    const { p } = await space('cmd-effort')
    expect((await cli(['task', 'add', 'Effort probe', '--agent', 'opencode', '--effort', 'high', '--space', p.name])).out).toContain('takes no effort level')
  })
})
