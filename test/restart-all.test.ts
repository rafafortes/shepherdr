// `shepherdr restart --all`: every coordinator of this machine's spaces whose Settings now say other than what its
// agent runs on, one restart each exactly as a single one (a turn at work stopped first, the same CLI resuming its
// session), never stopping at a space that fails. No task's agent, no other machine's place. A real LiveSource per
// test, its agents' starts stubbed at the one place they start (no herdr is here), and a herdr socket that isn't there.
import { describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('restart-all')
process.env.HERDR_SOCKET_PATH = join(process.env.SHEPHERDR_HOME, 'no-herdr.sock')
delete process.env.SHEPHERDR_MAIN
const { LiveSource } = await import('../server/live/source.ts')
const { placeId } = await import('../server/live/places.ts')
const { restartAllWords } = await import('../server/live/restart.ts')

type Src = InstanceType<typeof LiveSource>
type Started = { key: string; kind: string; model?: string; effort?: string; first?: string }

const REPO = 'git init -q -b main && git config user.email t@t && git config user.name T && echo hi > README.md && git add -A && git commit -qm init'

/** a source of its own for one test, stopped when it is over */
async function world(run: (w: { src: Src; started: Started[]; space: (name: string, on: { kind: string; model?: string; effort?: string }) => Promise<{ key: string; name: string }>; working: (key: string) => void; without: (kind: string) => void; cards: (key: string) => string[] }) => Promise<void>) {
  const src = new LiveSource()
  const started: Started[] = []
  const restart = src.agents.restart
  const installed = src.engine.installed
  const status = src.agents.status
  const interrupt = src.agents.interrupt
  src.agents.restart = (async (spec: Started, before?: () => Promise<string | void>) => {
    started.push({ key: spec.key, kind: spec.kind, model: spec.model, effort: spec.effort, first: (await before?.()) as string | undefined })
    return null
  }) as never
  src.engine.installed = () => true
  /** the spaces this test made, removed with it */
  const added: string[] = []
  /** a space of this machine whose coordinator runs on `on`, its Settings left as they are */
  const space = async (name: string, on: { kind: string; model?: string; effort?: string }) => {
    const dir = tmp('restart-all-repo')
    execSync(REPO, { cwd: dir, shell: '/bin/sh' })
    const p = await src.places.add(dir, name)
    added.push(p.name)
    const key = placeId.space(p.name)
    src.agents.records[key] = { key, name: `shep-${p.name}`, ...on, cwd: dir, workspace: p.name, logs: [], started: Date.now() }
    return { key, name: p.name }
  }
  const cards = (key: string) => src.chats.chat(key).messages.filter((m) => m.card?.restart).map((m) => m.card!.text)
  try {
    await run({
      src,
      started,
      space,
      /** a turn at work, ended by the interrupt an Esc sends: what the single restart's stopTurn does */
      working: (key) => {
        let at = true
        src.agents.status = ((k: string) => (k === key && at ? 'working' : status.call(src.agents, k))) as never
        src.agents.interrupt = (async (k: string) => {
          if (k === key) at = false
          return interrupt.call(src.agents, k)
        }) as never
      },
      without: (kind) => {
        src.engine.installed = ((k: string) => k !== kind) as never
      },
      cards,
    })
  } finally {
    src.agents.restart = restart
    src.agents.status = status
    src.agents.interrupt = interrupt
    src.engine.installed = installed
    // the spaces this test made leave with it: the home is the one place the next test starts from
    const leave = (src as unknown as { removeSpace(name: string): Promise<unknown> }).removeSpace.bind(src)
    for (const name of added) await leave(name).catch(() => undefined)
    src.stop()
  }
}

describe('restarting every coordinator on new Settings', () => {
  test('only the spaces whose Settings changed, one line each, the ones already on it counted, and the card in each chat', async () => {
    await world(async (w) => {
      const moved = await w.space('moved', { kind: 'claude' })
      const also = await w.space('also', { kind: 'claude' })
      const same = await w.space('same', { kind: 'codex' })
      // the two whose Settings now say Codex for their coordinators; the third's already do
      for (const { name } of [moved, also, same]) expect(w.src.settings.set('coordinator.agent', 'Codex', { space: name }).ok).toBe(true)
      // before the run, the snapshot names exactly the two whose chat says Settings moved
      expect(w.src.snapshot().places.filter((p) => p.restart).map((p) => p.name).sort()).toEqual(['also', 'moved'])
      const r = await w.src.cli(['restart', '--all'], {})
      expect(r.code).toBe(0)
      expect(w.started.map((x) => x.key).sort()).toEqual([moved.key, also.key].sort())
      // another CLI takes the chat over: the single restart's own line and card
      expect(w.started[0].first).toContain('the human restarted this chat on Codex')
      // (the stub never records a new start, so the snapshot keeps saying they differ: the pre-run one above is what
      // tells the places list's item what it will touch)
      expect(w.cards(moved.key)).toEqual(['Restarted on Codex'])
      expect(w.cards(also.key)).toEqual(['Restarted on Codex'])
      expect(w.cards(same.key)).toEqual([])
      const lines = r.out.trim().split('\n')
      expect(lines).toContain('moved: restarted on Codex')
      expect(lines).toContain('also: restarted on Codex')
      expect(lines).toContain('same: already on Codex, left alone')
      expect(lines).toContain('2 restarted, 2 already on it, 0 failed.')
      // what it never touches, said in one line
      expect(r.out).toContain("Tasks are not restarted: a running task's brief was written when it started, and restarting its agent is its own choice (shepherdr restart <id>).")
    })
  })

  test("a space that can't restart never stops the others: its line last and named, and the counts say it failed", async () => {
    await world(async (w) => {
      const ok = await w.space('ok', { kind: 'claude' })
      const broken = await w.space('broken', { kind: 'claude' })
      expect(w.src.settings.set('coordinator.agent', 'Codex', { space: ok.name }).ok).toBe(true)
      expect(w.src.settings.set('coordinator.agent', 'pi', { space: broken.name }).ok).toBe(true)
      // pi is not installed here: that space fails, and the one after it is still restarted
      w.without('pi')
      const r = await w.src.cli(['restart', '--all'], {})
      expect(r.code).toBe(0)
      expect(w.started.map((x) => x.key)).toEqual([ok.key])
      const lines = r.out.trim().split('\n')
      expect(lines).toEqual([
        'ok: restarted on Codex',
        // never started here (no agent record in this test): its line names what its next start will be on
        'home: nothing running yet, so its next start is on Claude Code',
        "broken: could not restart: pi isn't installed on this machine.",
        '1 restarted, 1 already on it, 1 failed.',
        "Tasks are not restarted: a running task's brief was written when it started, and restarting its agent is its own choice (shepherdr restart <id>).",
      ])
      expect(w.cards(broken.key)).toEqual([])
    })
  })

  test('a coordinator at work is interrupted first, exactly as a single restart, and its line says so', async () => {
    await world(async (w) => {
      const busy = await w.space('busy', { kind: 'claude' })
      const quiet = await w.space('quiet', { kind: 'claude' })
      for (const { name } of [busy, quiet]) expect(w.src.settings.set('coordinator.agent', 'Codex', { space: name }).ok).toBe(true)
      w.working(busy.key)
      const r = await w.src.cli(['restart', '--all'], {})
      expect(w.started.map((x) => x.key).sort()).toEqual([busy.key, quiet.key].sort())
      // it got there only once its turn was stopped: stopTurn waits for the interrupt the Esc sends, which a single
      // restart makes too, and the CLI that goes on is handed the single restart's own words
      expect(w.started.find((x) => x.key === busy.key)!.first).toContain('the human restarted this chat on Codex')
      const lines = r.out.trim().split('\n')
      expect(lines).toContain('busy: restarted on Codex, its working turn interrupted first')
      expect(lines).toContain('quiet: restarted on Codex')
    })
  })

  test("a task's agent is not restarted, whatever its Settings now say", async () => {
    await world(async (w) => {
      const p = await w.space('withtask', { kind: 'codex' })
      expect(w.src.settings.set('coordinator.agent', 'Codex', { space: p.name }).ok).toBe(true)
      const t = w.src.engine.add({ project: p.name, title: 'Say hello', desc: 'Add hello.txt.', by: 'test' })
      const key = `${t.id}/Agent`
      w.src.agents.records[key] = { key, name: `shep-${t.id}`, kind: 'claude', cwd: p.name, workspace: p.name, logs: [], started: Date.now() }
      expect(w.src.settings.set('task.agent', 'pi', { space: p.name }).ok).toBe(true)
      const r = await w.src.cli(['restart', '--all'], {})
      expect(r.code).toBe(0)
      expect(w.started).toEqual([])
      expect(w.cards(key)).toEqual([])
      // the home space and the space itself, nothing else: the task's agent is no place's coordinator
      expect(r.out).toContain("Nothing new in the Settings of this machine's coordinators (2): nothing was restarted.")
    })
  })

  test("another machine's spaces are left alone, and said so", async () => {
    await world(async (w) => {
      const mine = await w.space('mine', { kind: 'claude' })
      expect(w.src.settings.set('coordinator.agent', 'Codex', { space: mine.name }).ok).toBe(true)
      const theirs = {
        rec: { machine: 'nas', url: 'http://n/a', lastSeen: Date.now() },
        reachable: true,
        snap: {
          machines: [{ id: 'm:nas', machine: 'nas', name: 'nas', status: 'idle' }],
          places: [
            { id: 'p:nas:~', name: 'home', machine: 'nas', home: true, level: 1, status: 'idle', mode: 'regular', chat: 'p:nas:~' },
            { id: 'p:nas:notes', name: 'notes', machine: 'nas', level: 2, status: 'idle', mode: 'regular', chat: 'p:nas:notes' },
          ],
        },
      }
      const src = w.src as unknown as { peers?: unknown }
      const peers = src.peers
      // another machine's link, as this machine holds it: its places are seen and never touched
      src.peers = { list: () => [theirs], owner: (id: string) => (id.startsWith('p:nas:') ? theirs : undefined), ownerOfAction: () => undefined, stop: () => undefined }
      try {
        const r = await w.src.cli(['restart', '--all'], {})
        expect(r.code).toBe(0)
        expect(w.started.map((x) => x.key)).toEqual([mine.key])
        expect(r.out).toContain("Another machine's spaces are not touched here: nas (notes).")
      } finally {
        src.peers = peers
      }
    })
  })

  test('--all takes no target and no pick of its own, and a task agent never asks for it', async () => {
    await world(async (w) => {
      const p = await w.space('targeted', { kind: 'claude' })
      expect(w.src.settings.set('coordinator.agent', 'Codex', { space: p.name }).ok).toBe(true)
      const withTarget = await w.src.cli(['restart', '--all', p.name], {})
      expect(withTarget.code).toBe(1)
      expect(withTarget.out).toBe(`--all restarts every coordinator of this machine's spaces on what its Settings say, so it takes no space or task, not ${p.name}: shepherdr restart --all\n`)
      const withModel = await w.src.cli(['restart', '--all', '--model', 'Sonnet 5.5'], {})
      expect(withModel.code).toBe(1)
      expect(withModel.out).toBe("--all restarts every coordinator of this machine's spaces on what its Settings say, so it takes no --model of its own: shepherdr restart --all\n")
      expect(w.started).toEqual([])
      const t = w.src.engine.add({ project: p.name, title: 'Say hello', desc: 'Add hello.txt.', by: 'test' })
      const fromTask = await w.src.cli(['restart', '--all'], { chat: `${t.id}/Agent` })
      expect(fromTask.code).toBe(1)
      expect(fromTask.out).toContain("A task's agent restarts only its own agent; ask your coordinator or the human for --all.")
      expect(w.started).toEqual([])
    })
  })

  test('nothing to restart says so once, and Settings that already said the same are no change', async () => {
    await world(async (w) => {
      const agreeing = await w.space('agreeing', { kind: 'codex' })
      expect(w.src.settings.set('coordinator.agent', 'Codex', { space: agreeing.name }).ok).toBe(true)
      // its own pick in the chat's + menu: Settings said the same when it started, so they changed nothing
      const picked = await w.space('picked', { kind: 'claude', model: 'claude-sonnet-5-5' })
      w.src.agents.records[picked.key].set = { kind: 'claude', model: 'claude-opus-5-5' }
      expect(w.src.settings.set('coordinator.model', 'Opus 5.5', { space: picked.name }).ok).toBe(true)
      // nothing moved at all: one sentence, no line per space
      const nothing = await w.src.cli(['restart', '--all'], {})
      expect(nothing.code).toBe(0)
      expect(w.started).toEqual([])
      expect(nothing.out).toContain("Nothing new in the Settings of this machine's coordinators (3): nothing was restarted.")
      // one that does move: the line for the picked one still says what it really runs on, left alone
      const moved = await w.space('moved', { kind: 'claude' })
      expect(w.src.settings.set('coordinator.agent', 'Codex', { space: moved.name }).ok).toBe(true)
      const r = await w.src.cli(['restart', '--all'], {})
      expect(r.code).toBe(0)
      expect(w.started.map((x) => x.key)).toEqual([moved.key])
      const lines = r.out.trim().split('\n')
      expect(lines).toContain('picked: already on Claude Code (Sonnet 5.5), left alone')
      expect(lines).toContain('agreeing: already on Codex, left alone')
      expect(lines).toContain('1 restarted, 3 already on it, 0 failed.')
    })
  })
})

describe('the words of restart --all', () => {
  test('a coordinator that never started is no restart, and its line does not claim it is running', async () => {
    await world(async (w) => {
      const never = await w.space('never', { kind: 'claude' })
      delete w.src.agents.records[never.key]
      expect(w.src.settings.set('coordinator.agent', 'Codex', { space: never.name }).ok).toBe(true)
      // one that does move, so the per-space lines are printed at all
      const moved = await w.space('moved', { kind: 'claude' })
      expect(w.src.settings.set('coordinator.agent', 'Codex', { space: moved.name }).ok).toBe(true)
      const r = await w.src.cli(['restart', '--all'], {})
      expect(r.code).toBe(0)
      expect(w.started.map((x) => x.key)).toEqual([moved.key])
      expect(r.out).toContain('never: nothing running yet, so its next start is on Codex')
    })
  })

  test('the failures last and named, the counts, and what it never touches', () => {
    const out = restartAllWords(
      [
        { name: 'gtm', state: 'restarted', on: 'Codex', interrupted: true },
        { name: 'home', state: 'same', on: 'Claude Code (Opus 5.5, high)' },
        { name: 'web', state: 'restarted', on: 'pi (DeepSeek, high)' },
        { name: 'site', state: 'failed', error: "Codex isn't installed on this machine." },
      ],
      ['nas (notes)'],
    )
    expect(out.split('\n')).toEqual([
      'gtm: restarted on Codex, its working turn interrupted first',
      'web: restarted on pi (DeepSeek, high)',
      'home: already on Claude Code (Opus 5.5, high), left alone',
      "site: could not restart: Codex isn't installed on this machine.",
      '2 restarted, 1 already on it, 1 failed.',
      "Tasks are not restarted: a running task's brief was written when it started, and restarting its agent is its own choice (shepherdr restart <id>).",
      "Another machine's spaces are not touched here: nas (notes).",
    ])
  })

  test('nothing differed: one sentence, and still what it does not touch', () => {
    const out = restartAllWords([{ name: 'gtm', state: 'same', on: 'Codex' }])
    expect(out.split('\n')).toEqual([
      "Nothing new in the Settings of this machine's coordinators (1): nothing was restarted.",
      "Tasks are not restarted: a running task's brief was written when it started, and restarting its agent is its own choice (shepherdr restart <id>).",
    ])
  })
})
