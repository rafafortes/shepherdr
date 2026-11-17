// herdr drops a call when Shepherdr sends it late (a server whose loop stalls writes its request after herdr gave up
// reading it): server/live/herdr.ts tells that from herdr being down, asks a read again, and asks a change again only
// after looking at whether the first try took effect. Run against a herdr on a real socket that fails the way a loaded one
// does (test/socket-herdr.ts); the waits between tries are a few ms here (test/preload.ts).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { socketHerdr } from './socket-herdr.ts'

const { herdr, HerdrError, isPassing, rpc, retrying } = await import('../server/live/herdr.ts')

let h: ReturnType<typeof socketHerdr>
beforeEach(async () => {
  h = socketHerdr()
  process.env.HERDR_SOCKET_PATH = h.path
  await h.listen()
})
afterEach(() => h.stop())

const fails = async (f: () => Promise<unknown>) => {
  try {
    await f()
  } catch (e) {
    return e as InstanceType<typeof HerdrError>
  }
  throw new Error('it did not fail')
}

describe('what a failure says', () => {
  test('herdr not there is "herdr isn\'t answering", at once, and no pass', async () => {
    h.stop()
    const e = await fails(() => herdr.agents())
    expect(e.message).toBe("herdr isn't answering")
    expect(e.code).toBe('unreachable')
    expect(isPassing(e)).toBe(false)
  })

  test('a connection herdr closes with no reply is a passing failure, worded as such', async () => {
    h.fail('ping', 'drop')
    const e = await fails(() => herdr.ping())
    expect(e.message).toBe('herdr closed the connection during ping')
    expect(isPassing(e)).toBe(true)
  })

  test('a reset connection is a passing failure too, not herdr down', async () => {
    h.fail('ping', 'reset')
    const e = await fails(() => herdr.ping())
    expect(isPassing(e)).toBe(true)
    expect(e.message).not.toContain("isn't answering")
    expect(e.message).toMatch(/herdr (dropped|closed) the connection during ping/)
  })

  test('no reply in time is a passing failure', async () => {
    h.fail('ping', 'hang')
    const e = await fails(() => rpc('ping', {}, 60))
    expect(e.code).toBe('timeout')
    expect(isPassing(e)).toBe(true)
  })

  test('herdr saying no is not passing', async () => {
    const e = await fails(() => herdr.agent('nobody'))
    expect(e.code).toBe('agent_not_found')
    expect(isPassing(e)).toBe(false)
  })
})

describe('retrying', () => {
  test('asks again after each wait while the failure is passing, and gives the last one when they run out', async () => {
    let n = 0
    const f = async () => {
      n++
      throw new HerdrError('closed', 'x')
    }
    await expect(retrying(f, [1, 1])).rejects.toThrow('x')
    expect(n).toBe(3)
  })

  test('a failure that is not passing is not tried again', async () => {
    let n = 0
    await expect(
      retrying(async () => {
        n++
        throw new HerdrError('unreachable', "herdr isn't answering")
      }, [1, 1]),
    ).rejects.toThrow("isn't answering")
    expect(n).toBe(1)
  })
})

describe('a read dropped is asked again', () => {
  test('two drops and then the answer', async () => {
    h.agents.push({ name: 'a', pane_id: 'p1', agent: 'pi', agent_status: 'idle' })
    h.fail('agent.list', 'drop', 'reset')
    expect((await herdr.agents()).map((a) => a.name)).toEqual(['a'])
    expect(h.count('agent.list')).toBe(3)
  })

  test('a pane read and the visible screen, too', async () => {
    const w = h.space('w', '/x')
    h.panes[0].text = 'hello'
    h.fail('pane.read', 'drop')
    expect(await herdr.visible(w.root_pane.pane_id)).toBe('hello')
    h.fail('pane.read', 'drop')
    expect(await herdr.read(w.root_pane.pane_id, 'text')).toBe('hello')
  })

  test('a herdr that keeps dropping fails after the tries, with the error', async () => {
    h.fail('agent.list', 'drop', 'drop', 'drop', 'drop', 'drop')
    const e = await fails(() => herdr.agents())
    expect(isPassing(e)).toBe(true)
    expect(h.count('agent.list')).toBe(4)
  })

  test('a herdr that stays down still fails as "herdr isn\'t answering", with one try', async () => {
    h.stop()
    const e = await fails(() => herdr.workspaces())
    expect(e.message).toBe("herdr isn't answering")
  })

  test('a health look (ping) is asked once', async () => {
    h.fail('ping', 'drop')
    await fails(() => herdr.ping())
    expect(h.count('ping')).toBe(1)
  })
})

describe('a change dropped is asked again only if it did not happen', () => {
  test('a workspace the first try made is found, not made again', async () => {
    h.fail('workspace.create', 'drop-after')
    const r = await herdr.createWorkspace('shep-x', '/x')
    expect(h.spaces.filter((w) => w.label === 'shep-x')).toHaveLength(1)
    expect(r.workspace.label).toBe('shep-x')
    expect(h.panes.some((p) => p.pane_id === r.root_pane.pane_id)).toBe(true)
    expect(h.count('workspace.create')).toBe(1)
  })

  test('a workspace the first try never made is made by the second, once', async () => {
    h.fail('workspace.create', 'drop')
    const r = await herdr.createWorkspace('shep-x', '/x')
    expect(h.spaces.filter((w) => w.label === 'shep-x')).toHaveLength(1)
    expect(h.count('workspace.create')).toBe(2)
    expect(r.root_pane.pane_id).toBeTruthy()
  })

  test('a tab made and lost is found: one pane more, one call', async () => {
    const w = h.space('w', '/x')
    h.fail('tab.create', 'drop-after')
    const r = await herdr.createTab(w.workspace.workspace_id, 't', '/work')
    expect(h.panes.filter((p) => p.cwd === '/work')).toHaveLength(1)
    expect(h.panes.some((p) => p.pane_id === r.root_pane.pane_id)).toBe(true)
    expect(h.count('tab.create')).toBe(1)
  })

  test('a tab never made is made once more', async () => {
    const w = h.space('w', '/x')
    h.fail('tab.create', 'reset', 'drop')
    await herdr.createTab(w.workspace.workspace_id, 't', '/work')
    expect(h.panes.filter((p) => p.cwd === '/work')).toHaveLength(1)
    expect(h.count('tab.create')).toBe(3)
  })

  test('a worktree space made and lost is found by its label and folder', async () => {
    h.fail('worktree.create', 'drop-after')
    const r = await herdr.worktreeCreate({ cwd: '/repo' }, 'work/1-x', 'main', 'SHE-1', '/wt/1')
    expect(h.spaces.filter((w) => w.worktree)).toHaveLength(1)
    expect(r.worktree?.path).toBe('/wt/1')
    expect(r.workspace.label).toBe('SHE-1')
    expect(h.count('worktree.create')).toBe(1)
  })

  test('an agent started and lost is found on its pane: one start', async () => {
    const w = h.space('w', '/x')
    h.fail('agent.start', 'drop-after')
    const r = await herdr.start('shep-a', 'pi', w.root_pane.pane_id, [])
    expect(r.agent.name).toBe('shep-a')
    expect(h.agents.filter((a) => a.name === 'shep-a')).toHaveLength(1)
    expect(h.count('agent.start')).toBe(1)
  })

  test('an agent never started is started by the second try', async () => {
    const w = h.space('w', '/x')
    h.fail('agent.start', 'drop')
    await herdr.start('shep-a', 'pi', w.root_pane.pane_id, [])
    expect(h.agents.filter((a) => a.name === 'shep-a')).toHaveLength(1)
    expect(h.count('agent.start')).toBe(2)
  })

  test('a start that fails for a reason of its own is not asked again', async () => {
    const e = await fails(() => herdr.start('shep-a', 'pi', 'no-such-pane', []))
    expect(e.code).toBe('pane_not_found')
    expect(h.count('agent.start')).toBe(1)
  })

  test('a prompt that arrived is not sent again', async () => {
    const w = h.space('w', '/x')
    await herdr.start('shep-a', 'pi', w.root_pane.pane_id, [])
    h.fail('agent.prompt', 'drop-after')
    await herdr.prompt('shep-a', 'do the thing')
    expect(h.panes[0].text).toBe('do the thing\n')
    expect(h.count('agent.prompt')).toBe(1)
  })

  test('a prompt that never arrived is sent once more', async () => {
    const w = h.space('w', '/x')
    await herdr.start('shep-a', 'pi', w.root_pane.pane_id, [])
    h.fail('agent.prompt', 'drop')
    await herdr.prompt('shep-a', 'do the thing')
    expect(h.panes[0].text).toBe('do the thing\n')
    expect(h.count('agent.prompt')).toBe(2)
  })

  test('a long prompt, which a screen may fold, is not guessed at: it fails as it did, sent once', async () => {
    const w = h.space('w', '/x')
    await herdr.start('shep-a', 'pi', w.root_pane.pane_id, [])
    h.fail('agent.prompt', 'drop')
    const e = await fails(() => herdr.prompt('shep-a', 'x'.repeat(600)))
    expect(isPassing(e)).toBe(true)
    expect(h.count('agent.prompt')).toBe(1)
  })

  test('a pane closed and lost: the second try finds it gone and is done', async () => {
    const w = h.space('w', '/x')
    h.fail('pane.close', 'drop-after')
    await herdr.closePane(w.root_pane.pane_id)
    expect(h.panes).toHaveLength(0)
  })

  test('a pane that is not there is still an error at the first try', async () => {
    const e = await fails(() => herdr.closePane('nope'))
    expect(e.code).toBe('pane_not_found')
    expect(h.count('pane.close')).toBe(1)
  })

  test('a change that cannot be looked at (herdr keeps dropping) fails as it did', async () => {
    const w = h.space('w', '/x')
    h.fail('tab.create', 'drop-after')
    // the look before the call, and the look after it: four tries each
    h.fail('pane.list', ...Array<'drop'>(8).fill('drop'))
    const e = await fails(() => herdr.createTab(w.workspace.workspace_id, 't', '/work'))
    expect(isPassing(e)).toBe(true)
    // the one the first try made is the only one: nothing was asked a second time
    expect(h.count('tab.create')).toBe(1)
  })
})
