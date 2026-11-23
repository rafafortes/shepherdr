// Extra launch flags reach every CLI's argv, survive a resume and a crash's recovery, and are dropped (with a word to
// the log) on a switch to another CLI (upstream SHEP-266). herdr.start is spied: no CLI or pane is started here.
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('agent-flags')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')

const { Agents } = await import('../server/live/agents.ts')
type AgentRecord = import('../server/live/agents.ts').AgentRecord
type Spec = import('../server/live/agents.ts').Spec
const { herdr } = await import('../server/live/herdr.ts')

const cwd = tmp('agent-flags-cwd')
const KINDS = ['claude', 'codex', 'pi', 'opencode', 'agy'] as const
/** one flag each, real for that CLI (Codex isn't installed here, so its table supplies --search) */
const ONE: Record<(typeof KINDS)[number], string[]> = {
  claude: ['--advisor=opus'],
  codex: ['--search'],
  pi: ['--no-mcp'],
  opencode: ['--log-level=debug'],
  agy: ['--disable-slash-commands'],
}

const made: InstanceType<typeof Agents>[] = []
const spies: { mockRestore: () => void }[] = []
afterEach(() => {
  for (const a of made.splice(0)) a.stop()
  for (const s of spies.splice(0)) s.mockRestore()
})

function harness() {
  const a = new Agents()
  made.push(a)
  Object.assign(a, {
    refresh: async () => undefined,
    bindRoute: async () => undefined,
    queue: () => undefined,
  })
  return a
}

const record = (kind: string, flags?: string[], key = 'FLAG-1/Agent'): AgentRecord => ({
  key,
  name: Agents.nameFor(key),
  kind,
  cwd,
  workspace: 'w',
  access: 'full',
  flags,
  logs: [],
  started: Date.now(),
})

const spec = (kind: string, flags?: string[], extra: Partial<Spec> = {}): Spec => ({ ...record(kind, flags), first: 'first', pane: async () => 'pane', ...extra }) as Spec

describe('Agents.args puts the extra flags in each CLI’s argv', () => {
  for (const kind of KINDS) {
    test(`${kind}: the flags lead the argv, before what Shepherdr sets itself`, () => {
      const a = harness()
      const args = a.args(record(kind, ONE[kind]), false)
      expect(args.slice(0, ONE[kind].length)).toEqual(ONE[kind])
      // Shepherdr's own flags are still there once, and are never replaced by the extras
      expect(args.filter((x) => x === '--model' || x === '-m').length).toBeLessThanOrEqual(1)
      if (kind !== 'claude') expect(args).not.toContain('--advisor=opus')
    })
  }

  test('an agent with no flags has the argv it always had', () => {
    const a = harness()
    for (const kind of KINDS) expect(a.args(record(kind), false)).toEqual(a.args({ ...record(kind), flags: [] }, false))
  })
})

describe('the flags survive a relaunch, a resume and a recovery, and drop on a switch', () => {
  test('a resume and a crash’s recovery keep the record’s flags', async () => {
    const start = spyOn(herdr, 'start').mockResolvedValue(undefined as never)
    spies.push(start)
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation((() => 0) as never)
    spies.push(timer)
    const a = harness()
    await a.ensure(spec('claude', ['--advisor=opus']))
    const started = (start.mock.calls[0] as unknown as unknown[])[3] as string[]
    expect(started.slice(0, 1)).toEqual(['--advisor=opus'])
    // a relaunch with no new flags, the shape of a resume or a recovery, keeps what the record ran
    await a.ensure(spec('claude'))
    expect(a.record('FLAG-1/Agent')?.flags).toEqual(['--advisor=opus'])
    expect(((start.mock.calls[1] as unknown as unknown[])[3] as string[])[0]).toBe('--advisor=opus')
  })

  test('a switch to another CLI drops the old CLI’s flags and says so', async () => {
    const start = spyOn(herdr, 'start').mockResolvedValue(undefined as never)
    const info = spyOn(console, 'info').mockImplementation(() => undefined)
    spies.push(start, info)
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation((() => 0) as never)
    spies.push(timer)
    const a = harness()
    await a.ensure(spec('claude', ['--advisor=opus']))
    await a.ensure(spec('codex'))
    expect(a.record('FLAG-1/Agent')?.kind).toBe('codex')
    expect(a.record('FLAG-1/Agent')?.flags).toEqual([])
    expect((start.mock.calls[1] as unknown as unknown[])[3] as string[]).not.toContain('--advisor=opus')
    expect(info.mock.calls.some((c) => String(c[0]).includes('flags') && String(c[0]).includes('dropped'))).toBe(true)
  })

  test('a restart on the same CLI brings the new flags with it', async () => {
    const start = spyOn(herdr, 'start').mockResolvedValue(undefined as never)
    spies.push(start)
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation((() => 0) as never)
    spies.push(timer)
    const a = harness()
    await a.ensure(spec('claude', ['--advisor=opus']))
    await a.ensure(spec('claude', ['--verbose']))
    expect(a.record('FLAG-1/Agent')?.flags).toEqual(['--verbose'])
    expect(((start.mock.calls[1] as unknown as unknown[])[3] as string[])[0]).toBe('--verbose')
  })
})
