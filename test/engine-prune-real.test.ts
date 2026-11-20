// PERFS-12 with the real registry, not the engine-world stub: boot an Engine over a fixture agents.json and count
// exactly which records survive; and prove the guard that keeps every chat when tasks.json could not be read.
import { describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('engine-prune-real')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
const store = await import('../server/store.ts')
const realWriteJson = store.writeJson
const { Agents } = await import('../server/live/agents.ts')
const { Engine } = await import('../server/live/engine/engine.ts')
const { Places } = await import('../server/live/places.ts')
const { Settings } = await import('../server/live/settings.ts')
const { fakeHerdr } = await import('./fake-herdr.ts')

const record = (key: string) => ({ key, name: key, kind: 'pi', cwd: '/w', workspace: 'w', logs: [`/logs/${key}.jsonl`], started: 1 })
const task = (id: string) => ({ id, n: 1, project: '~', title: id, desc: 'x', by: 'test', created: 1, updated: 1 })
const keysOnDisk = (home: string) => Object.keys(JSON.parse(readFileSync(join(home, 'agents.json'), 'utf8'))).sort()

/** a real engine over a fixture home; the chats stand-in is never reached by the prune itself */
function boot(home: string, tasks?: unknown) {
  process.env.SHEPHERDR_HOME = home
  if (tasks !== undefined) realWriteJson('tasks.json', tasks, home)
  const agents = new Agents()
  const chats = new Proxy({}, { get: () => () => undefined })
  const engine = new Engine(agents, chats as never, new Places(), new Settings(), fakeHerdr().h as never)
  return { agents, engine }
}

describe('the engine prunes real records on a fixture home', () => {
  test('exactly the records of tasks the engine does not hold are dropped', () => {
    const home = tmp('engine-prune-ok')
    realWriteJson('agents.json', Object.fromEntries(['T-1/Agent', 'T-1/Reviewer', 'T-2/Agent', 'OLD-9/Agent', 'p:box:~'].map((key) => [key, record(key)])), home)
    const kept = ['T-1/Agent', 'T-1/Reviewer', 'T-2/Agent', 'p:box:~']
    const { agents, engine } = boot(home, { next: {}, tasks: [task('T-1'), task('T-2')] })
    try {
      expect(Object.keys(agents.records).sort()).toEqual(kept)
      expect(keysOnDisk(home)).toEqual(kept) // the prune is durable when startup returns
    } finally {
      engine.stop()
      agents.stop()
    }
  })

  test('a tasks.json that could not be read freezes the prune: no chat loses its record', () => {
    const home = tmp('engine-prune-frozen')
    realWriteJson('agents.json', Object.fromEntries(['T-1/Agent', 'p:box:~'].map((key) => [key, record(key)])), home)
    // invalid JSON: readJson copies it aside, returns its empty fallback and freezes the file for this run
    writeFileSync(join(home, 'tasks.json'), '{not json')
    const { agents, engine } = boot(home)
    try {
      expect(engine.tasks).toEqual([]) // the fallback the guard must not trust
      expect(store.readOnly(join(home, 'tasks.json'))).toBe(true)
      expect(Object.keys(agents.records).sort()).toEqual(['T-1/Agent', 'p:box:~'])
      expect(keysOnDisk(home)).toEqual(['T-1/Agent', 'p:box:~'])
    } finally {
      engine.stop()
      agents.stop()
    }
  })
})
