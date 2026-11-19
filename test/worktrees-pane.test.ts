// A task's agent pane, in the space of its worktree (worktrees.ts agentPane): herdr closes a space with its last pane,
// so an agent's pane going away — a hand-over ends its run — takes the worktree's space with it. A space that closes
// between finding it and opening a tab in it is opened again from the worktree, and the run has somewhere to go; a space
// just made is the one to be in, and any other failure is the start's own (SHE-166, POL-452).
import { describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('worktrees-pane')
const { Worktrees } = await import('../server/live/engine/worktrees.ts')
const { HerdrError } = await import('../server/live/herdr.ts')
const { fakeHerdr } = await import('./fake-herdr.ts')

const LABEL = 'T-166: keep the space'

const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, shell: '/bin/sh', encoding: 'utf8' }).trim()

/** a repo on main, and a task's worktree opened in herdr through its own API */
async function setup() {
  const at = tmp('worktrees-repo')
  sh('git init -q -b main && git config user.email t@t && git config user.name T && echo hi > README.md && git add -A && git commit -qm init', at)
  const fake = fakeHerdr()
  const wt = new Worktrees(fake.h as never)
  const home = { repo: at, name: 'proj' }
  const made = await wt.create(home, 'work/166-x', 'main', LABEL)
  return { fake, wt, home, made }
}

/** the space herdr has for a folder: its id, or nothing while it has closed it */
const spaceOf = (fake: ReturnType<typeof fakeHerdr>, path: string) => fake.spaces.find((w) => w.worktree?.checkout_path === path)

/** a herdr that lists a space and then closes it: what a look at herdr answers is a space that is gone by the time the
 *  call it answered for is made */
function closesAfterListing(fake: ReturnType<typeof fakeHerdr>, id: string) {
  const list = fake.h.workspaces
  let once = true
  fake.h.workspaces = async () => {
    const all = await list()
    if (once) {
      once = false
      const at = fake.spaces.findIndex((w) => w.workspace_id === id)
      if (at >= 0) fake.spaces.splice(at, 1)
    }
    return all
  }
}

describe("a task's agent pane", () => {
  test('a space that closed after it was found is opened again from the worktree, and the run goes in there', async () => {
    const { fake, wt, home, made } = await setup()
    // the agent's pane was the space's only one: finding the space and opening the tab in it race with herdr, which
    // closes a space with its last pane
    closesAfterListing(fake, made.workspace)
    const pane = await wt.agentPane({ home, wt: made.path, label: LABEL, tab: 'Agent', env: { A: '1' } })
    const again = spaceOf(fake, made.path)
    expect(again?.workspace_id).not.toBe(made.workspace)
    expect(again?.panes).toContain(pane)
    // one tab, and the shell herdr opened the space with is gone
    expect(again?.panes).toHaveLength(1)
    expect(fake.cwd.get(pane)).toBe(made.path)
  })

  test('a space that is there as it was: the tab goes in it, and no second space is made', async () => {
    const { fake, wt, home, made } = await setup()
    const pane = await wt.agentPane({ home, wt: made.path, label: LABEL, tab: 'Agent', env: {} })
    expect(spaceOf(fake, made.path)?.workspace_id).toBe(made.workspace)
    expect(spaceOf(fake, made.path)?.panes).toContain(pane)
  })

  test('a space just made (a start, its worktree new): a tab that fails there is the start’s own failure', async () => {
    const { fake, wt, home, made } = await setup()
    // nothing found by its worktree: the space it was told to be in is the one to be in
    const gone = { path: made.path, workspace: 'w-gone' }
    await expect(wt.agentPane({ home, wt: made.path, label: LABEL, tab: 'Agent', env: {}, made: gone })).rejects.toThrow('not found')
    expect(fake.spaces.some((w) => w.workspace_id === 'w-gone')).toBe(false)
  })

  test('a command herdr could not find is no closed space either: nothing is reopened', async () => {
    const { fake, wt, home, made } = await setup()
    const createTab = fake.h.createTab
    fake.h.createTab = async () => {
      // herdr's own words for a shell it could not run: "not found", and no space of it is gone
      throw new Error('agent start: claude: command not found')
    }
    try {
      await expect(wt.agentPane({ home, wt: made.path, label: LABEL, tab: 'Agent', env: {} })).rejects.toThrow('command not found')
      expect(spaceOf(fake, made.path)?.workspace_id).toBe(made.workspace)
    } finally {
      fake.h.createTab = createTab
    }
  })

  test('an agent or a tab herdr does not know is no closed space: nothing is reopened', async () => {
    const { fake, wt, home, made } = await setup()
    const createTab = fake.h.createTab
    fake.h.createTab = async () => {
      throw new HerdrError('agent_not_found', 'agent shep-t-1 not found')
    }
    try {
      await expect(wt.agentPane({ home, wt: made.path, label: LABEL, tab: 'Agent', env: {} })).rejects.toThrow('not found')
      expect(spaceOf(fake, made.path)?.workspace_id).toBe(made.workspace)
    } finally {
      fake.h.createTab = createTab
    }
  })

  test('any other failure from the tab is not mistaken for a closed space', async () => {
    const { fake, wt, home, made } = await setup()
    const createTab = fake.h.createTab
    fake.h.createTab = async () => {
      throw new HerdrError('invalid_request', 'tab.create: no such folder')
    }
    try {
      await expect(wt.agentPane({ home, wt: made.path, label: LABEL, tab: 'Agent', env: {} })).rejects.toThrow('no such folder')
      // the space was never given up for another
      expect(spaceOf(fake, made.path)?.workspace_id).toBe(made.workspace)
    } finally {
      fake.h.createTab = createTab
    }
  })
})

describe('a worktree space opened again', () => {
  test('one herdr still has is the one it is, with no shell to close', async () => {
    const { fake, wt, home, made } = await setup()
    const again = await wt.reopen(home, made.path, LABEL)
    expect(again).toEqual({ path: made.path, workspace: made.workspace, root: undefined })
    expect(fake.spaces.filter((w) => w.worktree?.checkout_path === made.path)).toHaveLength(1)
  })

  test('one herdr closed is made again from its worktree, its shell the one a start closes', async () => {
    const { fake, wt, home, made } = await setup()
    const list = fake.h.workspaces
    fake.h.workspaces = async () => {
      const all = await list()
      const at = fake.spaces.findIndex((w) => w.workspace_id === made.workspace)
      if (at >= 0) fake.spaces.splice(at, 1)
      return all
    }
    const again = await wt.reopen(home, made.path, LABEL)
    expect(again.workspace).not.toBe(made.workspace)
    expect(again.root).toBeDefined()
    expect(spaceOf(fake, made.path)?.workspace_id).toBe(again.workspace)
  })
})
