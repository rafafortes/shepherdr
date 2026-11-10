import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dependenciesPresent, prepare } from '../scripts/prepare.ts'
import { tmp } from './tmp.ts'

const dirs: string[] = []
/** processes a test started, stopped after it even when it times out */
const procs: (() => void)[] = []
afterEach(() => {
  for (const stop of procs.splice(0)) stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// All installation/build effects stay in a scratch checkout. No live install, server or state is involved.
function fixture(mode = '') {
  const root = tmp('prepare')
  dirs.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { example: '1.0.0' } }))
  writeFileSync(join(root, 'mode'), mode)
  const bun = join(root, 'bun')
  writeFileSync(bun, `#!${process.execPath}\n
import { appendFileSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync('calls', args.join(' ') + '\\n');
const mode = readFileSync('mode', 'utf8');
if (args[0] === 'install') {
  if (mode === 'install fails') { console.error('registry unavailable'); process.exit(1); }
  writeFileSync('installed', 'yes');
  if (mode !== 'install incomplete') {
    mkdirSync('node_modules/example', { recursive: true });
    writeFileSync('node_modules/example/package.json', JSON.stringify({ main: 'index.js' }));
    writeFileSync('node_modules/example/index.js', '');
  }
} else if (args[0] === 'run') {
  if (mode === 'build fails') { console.error('broken screen'); process.exit(1); }
  if (mode !== 'no screen') { mkdirSync('dist', { recursive: true }); writeFileSync('dist/index.html', 'screen'); }
} else if (mode === 'nested missing' && !existsSync('installed')) { console.error('missing nested import'); process.exit(1);
} else if (mode === 'server fails') { console.error('missing server import'); process.exit(1); }
`)
  chmodSync(bun, 0o755)
  const calls = () => existsSync(join(root, 'calls')) ? readFileSync(join(root, 'calls'), 'utf8') : ''
  return { root, bun, calls }
}

test('clean first start installs before building and checks the server', async () => {
  const f = fixture()
  expect(await prepare(f.root, f.bun)).toBeNull()
  expect(f.calls().split('\n').slice(0, 2)).toEqual(['install --frozen-lockfile', 'run build'])
  expect(f.calls()).toContain('build ')
  expect(existsSync(join(f.root, 'dist/index.html'))).toBe(true)
})

test('an empty node_modules is incomplete, including when a screen exists', async () => {
  const f = fixture()
  mkdirSync(join(f.root, 'node_modules'))
  mkdirSync(join(f.root, 'dist'))
  writeFileSync(join(f.root, 'dist/index.html'), 'old screen')
  expect(dependenciesPresent(f.root)).toBe(false)
  expect(await prepare(f.root, f.bun)).toBeNull()
  expect(f.calls()).toStartWith('install --frozen-lockfile\nrun build\n')
})

test('a package manifest without its entry file is incomplete', async () => {
  const f = fixture()
  mkdirSync(join(f.root, 'node_modules/example'), { recursive: true })
  writeFileSync(join(f.root, 'node_modules/example/package.json'), '{"main":"index.js"}')
  expect(dependenciesPresent(f.root)).toBe(false)
  expect(await prepare(f.root, f.bun)).toBeNull()
})

for (const [mode, message] of [
  ['install fails', 'registry unavailable'],
  ['install incomplete', 'without the required dependencies'],
  ['build fails', 'broken screen'],
  ['no screen', 'the build failed'],
  ['server fails', "server code doesn't load"],
]) test(mode + ' stops preparation clearly', async () => {
  const f = fixture(mode)
  expect(await prepare(f.root, f.bun)).toContain(message)
  if (mode.startsWith('install')) expect(f.calls()).toBe('install --frozen-lockfile\n')
})

test('a missing installer is a clear failure', async () => {
  const f = fixture()
  expect(await prepare(f.root, join(f.root, 'missing-bun'))).toContain('bun install failed')
})

test('healthy starts do not install or build again', async () => {
  const f = fixture()
  expect(await prepare(f.root, f.bun)).toBeNull()
  const calls = f.calls()
  expect(await prepare(f.root, f.bun)).toBeNull()
  expect(f.calls().slice(calls.length)).toStartWith('build ')
  expect(f.calls().slice(calls.length)).not.toContain('install')
  expect(f.calls().slice(calls.length)).not.toContain('run build')
})

test('failed preparation leaves an existing server answering and reports failure', async () => {
  const f = fixture()
  // Real lifecycle command with a scratch checkout; a separate disposable process represents the old server.
  writeFileSync(join(f.root, 'package.json'), JSON.stringify({ version: 'new', scripts: { build: 'echo broken-checkout >&2; exit 1' } }))
  const server = join(f.root, 'old-server.ts')
  writeFileSync(server, `const s = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
    return Response.json(req.url.endsWith('/api/version') ? { root: '/old-checkout', version: 'old', supervisor: process.pid } : {});
  } }); console.log(s.port);`)
  const old = Bun.spawn([process.execPath, server], { stdout: 'pipe', stderr: 'pipe' })
  try {
    const reader = old.stdout.getReader()
    const first = await reader.read()
    const port = Number(new TextDecoder().decode(first.value).trim())
    reader.releaseLock()
    const command = Bun.spawn([process.execPath, join(import.meta.dir, '../scripts/plugin.ts'), 'start'], {
      env: { ...process.env, HOME: f.root, SHEPHERDR_HOME: join(f.root, 'home'), HERDR_PLUGIN_ROOT: f.root,
        HERDR_PLUGIN_STATE_DIR: join(f.root, 'state'), HERDR_PLUGIN_ID: '', SHEPHERDR_PORT: String(port) },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [code, stderr] = await Promise.all([command.exited, new Response(command.stderr).text()])
    expect(code).toBe(1)
    expect(stderr).toContain('Shepherdr preparation failed')
    expect(stderr).toContain('broken-checkout')
    expect(old.exitCode).toBeNull()
    expect((await fetch(`http://127.0.0.1:${port}/api/snapshot`)).ok).toBe(true)
    expect(existsSync(join(f.root, 'state/supervisor.pid'))).toBe(false)
  } finally {
    old.kill()
    await old.exited
  }
})

/** A checkout ready to start (nothing to install or build) whose supervisor answers on the port it is given, and a
 *  supervisor of another checkout (or of this one) that holds that port without ever answering: a server too busy
 *  with a long snapshot to answer in time. It stops a second after SIGTERM, as a server finishing its work does. */
async function busyWorld(sameCheckout: boolean) {
  const f = fixture()
  writeFileSync(join(f.root, 'package.json'), JSON.stringify({ version: 'new' }))
  mkdirSync(join(f.root, 'dist'))
  writeFileSync(join(f.root, 'dist/index.html'), 'screen')
  mkdirSync(join(f.root, 'server'))
  writeFileSync(join(f.root, 'server/main.ts'), 'export {}\n')
  mkdirSync(join(f.root, 'scripts'))
  writeFileSync(join(f.root, 'scripts/supervise.ts'), `Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.SHEPHERDR_PORT), fetch() {
    return Response.json({ root: ${JSON.stringify(f.root)}, version: 'new', supervisor: process.pid });
  } });\n`)
  // holds the port and never answers; stops a second after SIGTERM
  const holder = `const l = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } }); console.log(l.port);
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 1000)); setInterval(() => {}, 1000);\n`
  let argv: string[]
  if (sameCheckout) {
    // its command line names this checkout's supervisor, which is what tells a supervisor's checkout
    writeFileSync(join(f.root, 'busy.ts'), holder)
    argv = [join(f.root, 'busy.ts'), join(f.root, 'scripts/supervise.ts')]
  } else {
    const oldRoot = tmp('prepare-old')
    dirs.push(oldRoot)
    mkdirSync(join(oldRoot, 'scripts'))
    writeFileSync(join(oldRoot, 'scripts/supervise.ts'), holder)
    argv = [join(oldRoot, 'scripts/supervise.ts')]
  }
  const old = Bun.spawn([process.execPath, ...argv], { stdout: 'pipe', stderr: 'pipe' })
  // the busy one, and whatever supervisor the pid file names by then (the new one, once it took over)
  procs.push(() => {
    old.kill()
    try {
      const p = Number(readFileSync(join(f.root, 'state/supervisor.pid'), 'utf8'))
      if (p !== old.pid) process.kill(p)
    } catch {}
  })
  const reader = old.stdout.getReader()
  const port = Number(new TextDecoder().decode((await reader.read()).value).trim())
  reader.releaseLock()
  mkdirSync(join(f.root, 'state'))
  writeFileSync(join(f.root, 'state/supervisor.pid'), String(old.pid))
  const start = () =>
    Bun.spawn([process.execPath, join(import.meta.dir, '../scripts/plugin.ts'), 'start'], {
      env: { ...process.env, HOME: f.root, SHEPHERDR_HOME: join(f.root, 'home'), HERDR_PLUGIN_ROOT: f.root,
        HERDR_PLUGIN_STATE_DIR: join(f.root, 'state'), HERDR_PLUGIN_ID: '', SHEPHERDR_PORT: String(port) },
      stdout: 'pipe', stderr: 'pipe',
    })
  return { f, old, port, start }
}

test("a server too busy to answer is swapped for this checkout's, never doubled beside it", async () => {
  const w = await busyWorld(false)
  const command = w.start()
  const [code, out] = await Promise.all([command.exited, new Response(command.stdout).text()])
  expect(out).toContain('holds the port without answering in time: restarting it on new')
  expect(code).toBe(0)
  // the old one was asked to stop, and the new one took the port once it was free
  expect(w.old.exitCode).toBe(0)
  const v = (await (await fetch(`http://127.0.0.1:${w.port}/api/version`)).json()) as { version: string; supervisor: number }
  expect(v.version).toBe('new')
  expect(Number(readFileSync(join(w.f.root, 'state/supervisor.pid'), 'utf8'))).toBe(v.supervisor)
}, 30_000)

test('a busy server of this very checkout is left alone', async () => {
  const w = await busyWorld(true)
  const command = w.start()
  const [code, out] = await Promise.all([command.exited, new Response(command.stdout).text()])
  expect(code).toBe(0)
  expect(out).toContain("busy: it didn't answer in time")
  expect(w.old.exitCode).toBeNull()
  expect(readFileSync(join(w.f.root, 'state/supervisor.pid'), 'utf8')).toBe(String(w.old.pid))
}, 30_000)

test('an exports-only package with missing files is incomplete', async () => {
  const f = fixture()
  mkdirSync(join(f.root, 'node_modules/example'), { recursive: true })
  writeFileSync(join(f.root, 'node_modules/example/package.json'), '{"exports":{".":"./dist/index.js"}}')
  expect(dependenciesPresent(f.root)).toBe(false)
  expect(await prepare(f.root, f.bun)).toBeNull()
  expect(f.calls()).toStartWith('install --frozen-lockfile\n')
})

test('a missing nested server import is repaired even with an existing screen and package entry', async () => {
  const f = fixture('nested missing')
  mkdirSync(join(f.root, 'dist'))
  writeFileSync(join(f.root, 'dist/index.html'), 'screen')
  mkdirSync(join(f.root, 'node_modules/example'), { recursive: true })
  writeFileSync(join(f.root, 'node_modules/example/package.json'), '{"main":"index.js"}')
  writeFileSync(join(f.root, 'node_modules/example/index.js'), '')
  expect(dependenciesPresent(f.root)).toBe(true)
  expect(await prepare(f.root, f.bun)).toBeNull()
  expect(f.calls()).toContain('install --frozen-lockfile\nrun build\n')
})
