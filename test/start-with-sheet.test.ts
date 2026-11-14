// What Start now with… and Start with… open on (source.ts restart-info `starts`): for a task that waits to start, the
// worker its go starts it on — Start with…'s pick once made, even while its agent waits in its worktree on another (as
// WEB-129's did, on OpenCode, when it was moved to Claude Code); else what that agent runs on, or its own or Settings'.
// A real LiveSource, a herdr socket that isn't there: nothing is started.
import { afterAll, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('start-with-sheet')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
delete process.env.SHEPHERDR_MAIN
const { LiveSource } = await import('../server/live/source.ts')
const { placeId } = await import('../server/live/places.ts')

const src = new LiveSource()
afterAll(() => src.stop())
src.engine.installed = () => true
const REPO = 'git init -q -b main && git config user.email t@t && git config user.name T && echo hi > README.md && git add -A && git commit -qm init'

type Info = { ok: boolean; info?: { on: { kind: string; model?: string }; starts?: { kind: string; model?: string; effort?: string } } }
const info = async (chat: string) => ((await src.act({ type: 'restart-info', chat })) as Info).info!

/** a task To do in a space of its own, its agent (on a CLI) waiting in its worktree for the go */
async function waiting(name: string, kind: string, model?: string) {
  const dir = tmp('start-with-repo')
  execSync(REPO, { cwd: dir, shell: '/bin/sh' })
  const p = await src.places.add(dir, name)
  const id = `SW-${Math.random().toString(36).slice(2, 6)}`
  src.engine.tasks.push({ id, n: 1, project: placeId.space(p.name), base: 'main', branch: 'main', worktree: dir, title: 'Waits', desc: 'Add a.txt.', by: 'test', created: Date.now(), updated: Date.now(), todo: true } as never)
  const key = `${id}/Agent`
  src.agents.records[key] = { key, name: id, kind, ...(model ? { model } : {}), cwd: dir, workspace: p.name, logs: [], started: Date.now() } as never
  return { id, key }
}

describe("Start with…'s pick is what the sheet opens on next", () => {
  const PICKS: { kind: string; model?: string; effort?: string; from: string }[] = [
    { kind: 'claude', model: 'claude-haiku-5-5', effort: 'high', from: 'opencode' },
    { kind: 'codex', model: 'gpt-6-sol', from: 'claude' },
    { kind: 'pi', model: 'openrouter/thinkingmachines/inkling-2-small:free', from: 'codex' },
    { kind: 'opencode', model: 'opencode/inkling-2-small-free', from: 'pi' },
    { kind: 'agy', model: 'gemini-4-argon', from: 'claude' },
  ]
  for (const x of PICKS)
    test(`picked ${x.kind}${x.model ? ` (${x.model})` : ''} over its ${x.from} agent waiting in its worktree`, async () => {
      const t = await waiting(`sw-${x.kind}`, x.from)
      // before: it starts on what its agent waits on
      expect((await info(t.key)).starts).toMatchObject({ kind: x.from })
      const r = await src.act({ type: 'start-with', chat: t.key, kind: x.kind, model: x.model ?? '', effort: x.effort ?? '' })
      expect(r).toEqual({ ok: true })
      const after = await info(t.key)
      // the sheet opens on the pick; what its agent runs on now is still said apart
      expect(after.starts).toEqual({ kind: x.kind, ...(x.model ? { model: x.model } : {}), ...(x.effort ? { effort: x.effort } : {}) })
      expect(after.on.kind).toBe(x.from)
    })

  test('a task that is not waiting (at work) has no such worker: its sheet restarts what it runs on', async () => {
    const t = await waiting('sw-work', 'pi')
    src.engine.task(t.id)!.todo = undefined
    ;(src.engine.task(t.id) as { told?: string }).told = 'work'
    src.engine.statusOf = ((x: { id: string }) => (x.id === t.id ? 'work' : 'todo')) as never
    try {
      expect((await info(t.key)).starts).toBeUndefined()
    } finally {
      delete (src.engine as { statusOf?: unknown }).statusOf
    }
  })
})
