// The routes folder (~/.shepherdr/helper/routes) gets one file per launch and, until SHE-185, nothing removed one. With
// 1700 files of dead processes a `shepherdr` call took about 90 s: route.pl asked `ps` about every dead pid (a fork and
// exec each) because its macOS fallback also ran on Linux. This covers both halves of the fix: the lookup never runs
// `ps` for a dead pid however many files there are, and `route.pl --prune` (which the server runs at start and every ten
// minutes) removes the files of processes that are gone and only those.
//
// Every CLI: the helper serves claude, codex, pi, opencode and agy alike. The ancestry walk is not per CLI: it reads
// /proc/<pid>/stat for each ancestor, and `cli_environment` takes a process by its executable name or npm entry point
// (`agent_executable`, covered per CLI in route-executable.test.ts). The tests here bind a plain process, since neither
// the prune nor the dead-pid shortcut looks at which CLI a route belongs to.
import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

const root = join(import.meta.dir, '..')
const ROUTE = join(root, 'helper', 'route.pl')
const perl = Bun.spawnSync(['perl', '-e', '1']).exitCode === 0

/** pids of processes that are gone: none of them exists in /proc now */
function deadPids(n: number): number[] {
  const max = Number(readFileSync('/proc/sys/kernel/pid_max', 'utf8').trim())
  const out: number[] = []
  for (let pid = max - 1; out.length < n && pid > 2; pid--) if (!existsSync(`/proc/${pid}`)) out.push(pid)
  return out
}

function sleeper() {
  return Bun.spawn(['/bin/sleep', '60'])
}

function bind(home: string, pid: number, route: Record<string, string>) {
  const r = Bun.spawnSync(['perl', ROUTE, '--bind', String(pid), JSON.stringify(route)], { env: { ...process.env, HOME: home } })
  expect(r.stderr.toString()).toBe('')
  expect(r.exitCode).toBe(0)
}

describe.if(perl)('route.pl --prune', () => {
  test('removes the files of dead processes and of reused pids, never a live one', async () => {
    const home = tmp('route-prune')
    const dir = join(home, '.shepherdr', 'helper', 'routes')
    mkdirSync(dir, { recursive: true })
    const live = sleeper()
    const reused = sleeper()
    const garbled = sleeper()
    try {
      bind(home, live.pid, { chat: 'LIVE-1/Agent', cwd: home, url: 'http://127.0.0.1:1' })
      // a pid that now belongs to another process: the stamp the file carries is not this process's
      writeFileSync(join(dir, `${reused.pid}.json`), JSON.stringify({ stamp: 'another start', chat: 'OLD-1/Agent', cwd: home }))
      // alive but unreadable: it cannot be judged, so it stays
      writeFileSync(join(dir, `${garbled.pid}.json`), '{not json')
      const dead = deadPids(300)
      for (const pid of dead) writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ stamp: '1', chat: `DEAD-${pid}/Agent`, cwd: home }))
      // a --bind killed before its rename leaves a temporary file: old ones go, one being written stays
      const oldTmp = join(dir, `${dead[0]}.4242.tmp`)
      const freshTmp = join(dir, `${dead[1]}.4243.tmp`)
      writeFileSync(oldTmp, '{}')
      writeFileSync(freshTmp, '{}')
      const old = new Date(Date.now() - 3600_000)
      utimesSync(oldTmp, old, old)
      writeFileSync(join(dir, 'README'), 'not a route')

      const r = Bun.spawnSync(['perl', ROUTE, '--prune'], { env: { ...process.env, HOME: home } })
      expect(r.stderr.toString()).toBe('')
      expect(r.exitCode).toBe(0)
      // 300 dead, the reused pid's file and the old temporary file
      expect(r.stdout.toString().trim()).toBe('302')
      expect(readdirSync(dir).sort()).toEqual([`${live.pid}.json`, `${garbled.pid}.json`, `${dead[1]}.4243.tmp`, 'README'].sort())
      // the live one still routes: its file is whole
      expect(JSON.parse(readFileSync(join(dir, `${live.pid}.json`), 'utf8')).chat).toBe('LIVE-1/Agent')
      // and a second pass finds nothing to do
      expect(
        Bun.spawnSync(['perl', ROUTE, '--prune'], { env: { ...process.env, HOME: home } })
          .stdout.toString()
          .trim(),
      ).toBe('0')
    } finally {
      for (const p of [live, reused, garbled]) p.kill()
    }
  })

  test('a missing routes folder is nothing to prune, not an error', () => {
    const home = tmp('route-prune-none')
    const r = Bun.spawnSync(['perl', ROUTE, '--prune'], { env: { ...process.env, HOME: home } })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.toString().trim()).toBe('0')
  })
})

describe.if(perl)('the lookup with thousands of stale route files', () => {
  /** a `shepherdr show` run from `cwd`, its server answering with the chat it was routed to; `ps` is a shim that logs each
   *  call, so a lookup that forks it for a dead pid shows. Returns the chat it reached and how many times ps ran. */
  async function lookup(opts: { dead: number; ancestry: boolean }) {
    const home = tmp('route-many')
    const dir = join(home, '.shepherdr', 'helper', 'routes')
    mkdirSync(dir, { recursive: true })
    const folder = join(home, 'worktree')
    mkdirSync(folder)
    const bin = join(home, 'bin')
    mkdirSync(bin)
    const log = join(home, 'ps.log')
    writeFileSync(join(bin, 'ps'), `#!/bin/sh\necho "$@" >> ${log}\nexit 1\n`)
    chmodSync(join(bin, 'ps'), 0o755)
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async (req) => Response.json({ out: `${((await req.json()) as { chat: string }).chat}\n`, code: 0 }) })
    const url = `http://127.0.0.1:${server.port}`
    // every stale file claims this same folder: one wrongly counted as live would make the folder ambiguous
    for (const pid of deadPids(opts.dead)) writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ stamp: '1', chat: `DEAD-${pid}/Agent`, cwd: folder, url: 'http://127.0.0.1:1' }))
    const route = JSON.stringify({ cwd: folder, chat: 'SHE-9/Agent', url })
    const cli = join(root, 'bin', 'shepherdr')
    // ancestry: this process owns the binding and runs the CLI. Otherwise a sibling owns it and only its folder says so.
    const code = opts.ancestry
      ? `
        const b = Bun.spawnSync(['perl', ${JSON.stringify(ROUTE)}, '--bind', String(process.pid), ${JSON.stringify(route)}]);
        if (b.exitCode) throw new Error(b.stderr.toString());
        const p = Bun.spawnSync([${JSON.stringify(cli)}, 'show'], { cwd: ${JSON.stringify(folder)} });
        process.stdout.write(p.stdout); process.stderr.write(p.stderr); process.exitCode = p.exitCode;
      `
      : `
        const owner = Bun.spawn(['/bin/sleep', '30']);
        try {
          const b = Bun.spawnSync(['perl', ${JSON.stringify(ROUTE)}, '--bind', String(owner.pid), ${JSON.stringify(route)}]);
          if (b.exitCode) throw new Error(b.stderr.toString());
          const p = Bun.spawnSync([${JSON.stringify(cli)}, 'show'], { cwd: ${JSON.stringify(folder)} });
          process.stdout.write(p.stdout); process.stderr.write(p.stderr); process.exitCode = p.exitCode;
        } finally { owner.kill(); }
      `
    try {
      const p = Bun.spawn([process.execPath, '-e', code], {
        env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, SHEPHERDR_CHAT: 'SHE-9/Agent', SHEPHERDR_URL: '', SHEPHERDR_SECRET_FILE: '' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
      const psCalls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0
      return { out, err, code: p.exitCode, psCalls }
    } finally {
      server.stop(true)
    }
  }

  test.if(existsSync('/proc/self/stat'))(
    'a folder match among 3000 dead routes reaches the live owner and never forks ps',
    async () => {
      const r = await lookup({ dead: 3000, ancestry: false })
      expect(r.err).toBe('')
      expect(r.out).toBe('SHE-9/Agent\n')
      expect(r.psCalls).toBe(0)
    },
    60_000,
  )

  test.if(existsSync('/proc/self/stat'))(
    'an ancestor owner among 3000 dead routes is found, and never forks ps',
    async () => {
      const r = await lookup({ dead: 3000, ancestry: true })
      expect(r.err).toBe('')
      expect(r.out).toBe('SHE-9/Agent\n')
      expect(r.psCalls).toBe(0)
    },
    60_000,
  )
})
