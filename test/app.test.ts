// The web server lets only this app's own pages (and local programs) act: another website can't.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { startApp } from '../server/app.ts'
import { refusedHosts } from '../server/hosts.ts'
import type { Push } from '../server/push.ts'
import { UPLOAD_TOO_LARGE } from '../shared/files.ts'
import type { Alert, Snapshot, UpdateStatus } from '../shared/types.ts'
import { Emitter, type Source, type SourceEvents } from '../server/source.ts'
import { tmp } from './tmp.ts'

const acted: unknown[] = []
class Stub extends Emitter<SourceEvents> {
  kind = 'demo' as const
  /** how many snapshots were built here, so a burst of alerts' builds can be counted (SHE-78) */
  snapshots = 0
  settings: Snapshot['settings'] = []
  snapshot() {
    this.snapshots++
    return { name: 'x', host: 'h', places: [], tasks: [], automations: {}, artifacts: [], asks: {}, settings: this.settings, user: 'u' }
  }
  chat() {
    return undefined
  }
  async act(a: unknown) {
    acted.push(a)
    return { ok: true }
  }
  async artifact(id: string, v?: number) {
    return id === 'ab12' ? { html: `<h1>v${v ?? 2}</h1>`, data: { n: '</script><script>alert(1)</script>' }, sent: undefined } : undefined
  }
  async artifactThumb(id: string) {
    return id === 'ab12' ? new Blob(['png'], { type: 'image/png' }) : null
  }
  watch() {}
  uploads: { chat: string; name: string; size: number }[] = []
  async upload(chat: string, name: string, data: Uint8Array) {
    this.uploads.push({ chat, name, size: data.byteLength })
    return `/inbox/${chat}/${name}`
  }
  async attachment(chat: string, path: string) {
    return chat === 'c' && path.startsWith('/inbox/') ? new Blob(['<svg onload="alert(1)"/>']) : null
  }
  voice() {
    return { audio() {}, end() {} }
  }
  browser(task: string, ws: { send(d: string): void }) {
    ws.send(JSON.stringify({ type: 'state', task }))
    return { message: (d: string) => ws.send(d), end() {} }
  }
  async folders(machine: string, path: string) {
    if (path.startsWith('/')) throw new Error('Only folders in your home can be added.')
    return { path, exists: true, dir: true, repo: null, entries: [{ name: 'dev', path: `~/dev`, repo: false }], machine }
  }
  async worktree(ask: { task: string; what: string; path?: string }) {
    if (ask.path?.includes('..')) throw new Error('No such file.')
    return { asked: ask }
  }
  async addSpace(req: unknown) {
    acted.push(req)
    return { place: 'p:h:x' }
  }
}

const pushed: { alert: Alert; skip: Set<string> }[] = []
const push = { publicKey: 'k', send: async (alert: Alert, skip: Set<string>) => void pushed.push({ alert, skip }) }
const source = new Stub()
const server = startApp({ source: source as unknown as Source, dist: '/nonexistent', push: push as unknown as Push, port: 0 })
const base = `http://127.0.0.1:${server.port}`
afterAll(() => server.stop(true))

const postAt = (at: string, headers: Record<string, string>) =>
  fetch(`${at}/api/action`, { method: 'POST', headers: { 'content-type': 'text/plain', ...headers }, body: JSON.stringify({ type: 'mode', place: 'all', mode: 'autopilot' }) })
const post = (headers: Record<string, string>) => postAt(base, headers)

// a second server with a published name, as the app behaves once app.hosts is set
const published = startApp({ source: new Stub() as unknown as Source, dist: '/nonexistent', port: 0, hosts: () => ['app.example.com'] })
afterAll(() => published.stop(true))

// a server with a tiny upload cap, so an over-cap post needs no 100 MB body; it records what the source would write
const CAP = 1024
const capped = new Stub()
const cappedServer = startApp({ source: capped as unknown as Source, dist: '/nonexistent', port: 0, uploadCap: CAP })
const cappedBase = `http://127.0.0.1:${cappedServer.port}`
afterAll(() => cappedServer.stop(true))

describe('the Host header', () => {
  test('a rebound Host is refused with 421 on every API route, with or without Origin', async () => {
    const n = acted.length
    const host = `evil.example:${server.port}`
    for (const path of ['/api/snapshot', '/api/action', '/api/ws', '/api/file?chat=c&path=/inbox/c/x.png']) {
      const r = await fetch(`${base}${path}`, { headers: { host, origin: `http://${host}` } })
      expect(r.status).toBe(421)
      expect(await r.text()).toContain(`shepherdr set app.hosts ${host}`)
    }
    expect((await post({ host, 'x-shepherdr': '1' })).status).toBe(421)
    expect(acted.length).toBe(n)
  })

  test('loopback and the configured host are accepted, with and without Origin', async () => {
    const allowed: [string, string][] = [
      [`127.0.0.1:${server.port}`, base],
      [`localhost:${server.port}`, base],
      [`[::1]:${server.port}`, base],
      ['app.example.com', `http://127.0.0.1:${published.port}`],
    ]
    for (const [host, at] of allowed) {
      expect((await fetch(`${at}/api/snapshot`, { headers: { host } })).status).toBe(200)
      expect((await fetch(`${at}/api/snapshot`, { headers: { host, origin: `https://${host}` } })).status).toBe(200)
    }
    // the app's own page still writes with its header, on loopback and through the published name alike
    expect((await postAt(base, { host: `127.0.0.1:${server.port}`, origin: `http://127.0.0.1:${server.port}`, 'x-shepherdr': '1', 'sec-fetch-site': 'same-origin' })).status).toBe(200)
    expect((await postAt(`http://127.0.0.1:${published.port}`, { host: 'app.example.com', origin: 'https://app.example.com', 'x-shepherdr': '1', 'sec-fetch-site': 'same-origin' })).status).toBe(200)
  })

  test('the shepherdr command reaches /api/cli on loopback', async () => {
    const r = await fetch(`${base}/api/cli`, { method: 'POST', headers: { host: `127.0.0.1:${server.port}` }, body: JSON.stringify({ args: ['status'] }) })
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('does not accept shepherdr commands')
  })

  test('a refused host is logged once, and the list stays bounded', async () => {
    const errors: string[] = []
    const log = console.error
    console.error = (...a: unknown[]) => void errors.push(a.join(' '))
    try {
      for (let i = 0; i < 2; i++) expect((await fetch(`${base}/api/snapshot`, { headers: { host: 'once.example:7787' } })).status).toBe(421)
      for (let i = 0; i < 25; i++) await fetch(`${base}/api/snapshot`, { headers: { host: `many-${i}.example:7787` } })
    } finally {
      console.error = log
    }
    expect(errors.filter((e) => e.includes('once.example'))).toHaveLength(1)
    expect(refusedHosts.size).toBeLessThanOrEqual(20)
    refusedHosts.clear()
  })
})

describe('who may act', () => {
  test('another website is refused, with or without content type tricks', async () => {
    const n = acted.length
    expect((await post({ origin: 'https://evil.example' })).status).toBe(403)
    expect((await post({ origin: 'https://evil.example', 'x-shepherdr': '1' })).status).toBe(403)
    expect((await post({ origin: 'null' })).status).toBe(403)
    expect((await post({ 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect(acted.length).toBe(n)
  })
  test("the app's own page needs its header", async () => {
    const host = `127.0.0.1:${server.port}`
    expect((await post({ origin: `http://${host}` })).status).toBe(403)
    expect((await post({ origin: `http://${host}`, 'x-shepherdr': '1', 'sec-fetch-site': 'same-origin' })).status).toBe(200)
  })
  test('a program on this machine (no Origin) may act', async () => {
    expect((await post({})).status).toBe(200)
  })
  test('a WebSocket from another website is refused', async () => {
    for (const path of ['/api/ws', '/api/browser?task=X-1']) {
      const r = await fetch(`${base}${path}`, {
        headers: { origin: 'https://evil.example', upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': `${'dGhlIHNhbXBsZSBub25jZQ'}==`, 'sec-websocket-version': '13' },
      })
      expect(r.status).toBe(403)
    }
  })
  test('the Browser panel’s link reaches the task’s browser through the app, both ways', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/browser?task=X-1`)
    const got: unknown[] = []
    ws.onmessage = (e) => got.push(JSON.parse(String(e.data)))
    await new Promise((r) => (ws.onopen = r))
    ws.send(JSON.stringify({ type: 'take' }))
    while (got.length < 2) await new Promise((r) => setTimeout(r, 10))
    expect(got).toEqual([{ type: 'state', task: 'X-1' }, { type: 'take' }])
    ws.close()
  })
})

describe('alerts', () => {
  const alert: Alert = { id: 'a1', from: 'Shepherdr', title: 'X-1 needs you', body: '', go: { place: 'all', task: 'X-1' } }
  const open = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws`)
    const got: { type: string }[] = []
    ws.onmessage = (e) => got.push(JSON.parse(String(e.data)))
    await new Promise((r) => (ws.onopen = r))
    return { ws, got }
  }
  const settle = () => new Promise((r) => setTimeout(r, 50))

  // an alert path of its own: a push that never finishes cannot ask for another snapshot behind the test's back
  const quiet = { publicKey: 'k', send: () => new Promise<void>(() => {}) } as unknown as Push
  const apps: ReturnType<typeof startApp>[] = []
  const isolated = (stub: Stub, p: Push = quiet) => {
    const app = startApp({ source: stub as unknown as Source, dist: '/nonexistent', push: p, port: 0 })
    apps.push(app)
    return app
  }
  afterAll(() =>
    apps.forEach((a) => {
      a.stop(true)
    }),
  )
  const place = 'p:h:x'
  const coordinator: Alert = { id: 'a2', from: 'Shepherdr', title: 'Coordinator asks', body: '', go: { place } }

  test('two alerts inside a second build one snapshot between them', () => {
    const s = new Stub()
    isolated(s)
    s.emit('alert', alert)
    s.emit('alert', alert)
    expect(s.snapshots).toBe(1)
  })

  test('alerts reuse the snapshot a screen just built, and build again once it is a second old', async () => {
    const s = new Stub()
    const app = isolated(s)
    const ws = new WebSocket(`ws://127.0.0.1:${app.port}/api/ws`)
    await new Promise((r) => (ws.onopen = r))
    // a change with a screen open builds one through the 'snapshot' handler; wait for it (opening makes one of its own)
    const made = s.snapshots
    s.emit('snapshot')
    for (let i = 0; i < 200 && s.snapshots === made; i++) await Bun.sleep(5)
    expect(s.snapshots).toBe(made + 1)
    const fresh = s.snapshots
    s.emit('alert', alert)
    s.emit('alert', alert)
    expect(s.snapshots).toBe(fresh)
    const now = Date.now
    let clock = now()
    Date.now = () => clock
    try {
      clock += 1001
      s.emit('alert', alert)
      expect(s.snapshots).toBe(fresh + 1)
    } finally {
      Date.now = now
      ws.close()
    }
  })

  test('Notify Off sends nothing, a task in the same place still sends', () => {
    const sent: string[] = []
    const s = new Stub()
    s.settings = [{ name: 'Notify', level: place, rows: [{ label: 'Notify', key: 'notify', value: 'Off', options: [] }] }]
    isolated(s, { publicKey: 'k', send: async (a: Alert) => void sent.push(a.id) } as unknown as Push)
    s.emit('alert', coordinator)
    s.emit('alert', coordinator)
    expect(sent).toEqual([])
    s.emit('alert', { ...alert, task: true, go: { place } })
    expect(sent).toEqual(['a1'])
  })

  test('the app on screen shows no alert, and its device gets no push', async () => {
    const phone = await open()
    const mac = await open()
    phone.ws.send(JSON.stringify({ type: 'watch', chats: [], term: null, visible: true, push: 'phone' }))
    mac.ws.send(JSON.stringify({ type: 'watch', chats: [], term: null, visible: false, push: 'mac' }))
    await settle()
    source.emit('alert', alert)
    await settle()
    expect(pushed.at(-1)?.alert.id).toBe('a1')
    expect([...pushed.at(-1)!.skip]).toEqual(['phone'])
    expect([...phone.got, ...mac.got].some((m) => m.type === 'alert')).toBe(false)
    phone.ws.close()
    mac.ws.close()
  })
  test('with the app closed or in the background, every device gets the push', async () => {
    const phone = await open()
    phone.ws.send(JSON.stringify({ type: 'watch', chats: [], term: null, visible: false, push: 'phone' }))
    await settle()
    source.emit('alert', alert)
    phone.ws.close()
    await settle()
    source.emit('alert', alert)
    expect(pushed.at(-2)!.skip.size).toBe(0)
    expect(pushed.at(-1)!.skip.size).toBe(0)
  })
})

describe('updates', () => {
  const dir = tmp('app')
  mkdirSync(join(dir, 'dist'))
  writeFileSync(join(dir, 'dist', 'index.html'), '<script type="module" src="./assets/index-AbC123.js"></script>')
  const updates = join(dir, 'home', 'update.json')
  const app = startApp({ source: source as unknown as Source, dist: join(dir, 'dist'), port: 0, updates })
  afterAll(() => app.stop(true))
  const open = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${app.port}/api/ws`)
    const got: { type: string; id?: string; update?: UpdateStatus | null }[] = []
    ws.onmessage = (e) => got.push(JSON.parse(String(e.data)))
    await new Promise((r) => (ws.onopen = r))
    await new Promise((r) => setTimeout(r, 50))
    return { ws, got }
  }

  test('every screen hears which build the server serves', async () => {
    const { ws, got } = await open()
    expect(got.find((m) => m.type === 'build')?.id).toBe('assets/index-AbC123.js')
    expect(got.find((m) => m.type === 'update')?.update).toBeNull()
    ws.close()
  })
  test('a screen back on view pings its link, and a live one answers at once', async () => {
    const { ws, got } = await open()
    ws.send(JSON.stringify({ type: 'ping' }))
    for (let i = 0; i < 40 && !got.some((m) => m.type === 'pong'); i++) await new Promise((r) => setTimeout(r, 25))
    expect(got.at(-1)).toEqual({ type: 'pong' })
    ws.close()
  })
  test('a failed update reaches every open screen, and the ones that open later', async () => {
    const { ws, got } = await open()
    const failed: UpdateStatus = { state: 'failed', commit: 'abc1234', subject: 'SHE-9: x', built: 'def5678', error: 'the build failed:\nboom', at: 1 }
    writeFileSync(updates, JSON.stringify(failed))
    for (let i = 0; i < 40 && !got.some((m) => m.update?.state === 'failed'); i++) await new Promise((r) => setTimeout(r, 50))
    expect(got.at(-1)).toEqual({ type: 'update', update: failed })
    ws.close()
    const later = await open()
    expect(later.got.find((m) => m.type === 'update')?.update).toEqual(failed)
    later.ws.close()
  })
  test('the updater stops new calls and sees the ones on in one step; a call arriving after that is turned away', async () => {
    const drain = async (on: boolean) => ((await (await fetch(`http://127.0.0.1:${app.port}/api/drain`, { method: 'POST', body: JSON.stringify({ on }) })).json()) as { calls: number }).calls
    const call = async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${app.port}/api/voice?chat=gtm`)
      const got: { type: string; message?: string }[] = []
      ws.onmessage = (e) => got.push(JSON.parse(String(e.data)))
      await new Promise((r) => (ws.onopen = r))
      await new Promise((r) => setTimeout(r, 50))
      return { ws, got }
    }
    const on = await call()
    expect(await drain(true)).toBe(1)
    // the updater waits for it, letting calls start meanwhile
    expect(await drain(false)).toBe(1)
    on.ws.close()
    await new Promise((r) => setTimeout(r, 50))
    expect(await drain(true)).toBe(0)
    // between that look and the restart, a new call can't start: it is told why
    const late = await call()
    expect(late.got).toEqual([{ type: 'error', message: 'Shepherdr is updating. Call again in a moment.' }])
    expect(late.ws.readyState).not.toBe(WebSocket.OPEN)
    expect(await drain(true)).toBe(0)
    expect(await drain(false)).toBe(0)
  })
})

describe('attached files', () => {
  const get = (path: string, headers: Record<string, string> = {}, extra = '') => fetch(`${base}/api/file?chat=c&path=${encodeURIComponent(path)}${extra}`, { headers })
  test('a picture opens as itself, sealed off: nothing in it runs with the app', async () => {
    const r = await get('/inbox/c/mf1-shot.svg')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/svg+xml')
    expect(r.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''shot.svg")
    expect(r.headers.get('content-security-policy')).toStartWith('sandbox')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
  })
  test('a page or script shows as text; anything else downloads; Download always does', async () => {
    expect((await get('/inbox/c/x-page.html')).headers.get('content-type')).toBe('text/plain; charset=utf-8')
    const bin = await get('/inbox/c/x-tool.exe')
    expect(bin.headers.get('content-type')).toBe('application/octet-stream')
    expect(bin.headers.get('content-disposition')).toStartWith('attachment')
    expect((await get('/inbox/c/x-shot.png', {}, '&download=1')).headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''shot.png")
  })
  test("only what the source says was attached; another website can't load it", async () => {
    expect((await get('/etc/passwd')).status).toBe(404)
    expect((await get('/inbox/c/x-shot.png', { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
  })
  test('a video is played part at a time, so a phone starts it and seeks without downloading it again', async () => {
    const body = '<svg onload="alert(1)"/>'
    const all = await get('/inbox/c/x-clip.mp4')
    expect(all.status).toBe(200)
    expect(all.headers.get('content-type')).toBe('video/mp4')
    expect(all.headers.get('accept-ranges')).toBe('bytes')
    expect(await all.text()).toBe(body)
    const part = await get('/inbox/c/x-clip.mp4', { range: 'bytes=5-7' })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe(`bytes 5-7/${body.length}`)
    expect(await part.text()).toBe(body.slice(5, 8))
    // the end of it, a part a player asks for last
    expect(await (await get('/inbox/c/x-clip.mp4', { range: 'bytes=-3' })).text()).toBe(body.slice(-3))
    // a span past the end of it can't be met
    const bad = await get('/inbox/c/x-clip.mp4', { range: 'bytes=99-' })
    expect(bad.status).toBe(416)
    expect(bad.headers.get('content-range')).toBe(`bytes */${body.length}`)
  })
  test('a tile asks for a small copy: without one, a picture is its own thumbnail and a video has no still', async () => {
    // the stub source makes none: a picture comes back whole (a phone still shows it), a video's still says it has none
    const thumb = await get('/inbox/c/x-shot.png', {}, '&thumb=1')
    expect(thumb.status).toBe(200)
    expect(thumb.headers.get('content-type')).toBe('image/png')
    expect(await thumb.text()).toBe('<svg onload="alert(1)"/>')
    expect((await get('/inbox/c/x-clip.mp4', {}, '&poster=1')).status).toBe(404)
    // and a path the source refuses is refused the same way, never read from disk
    expect((await get('/etc/passwd', {}, '&thumb=1')).status).toBe(404)
  })
})

describe('upload cap', () => {
  const postFile = (size: number) => {
    const body = new FormData()
    body.append('chat', 'c')
    body.append('file', new Blob([new Uint8Array(size)]), 'big.png')
    return fetch(`${cappedBase}/api/upload`, { method: 'POST', body })
  }

  test('a file over the cap is refused with 413 and nothing is written', async () => {
    const before = capped.uploads.length
    const r = await postFile(CAP + 1)
    expect(r.status).toBe(413)
    expect(await r.json()).toEqual({ error: UPLOAD_TOO_LARGE })
    expect(capped.uploads.length).toBe(before)
  })

  test('a content-length over the cap is refused before any body is read', async () => {
    // a raw socket sends the header with no body at all: without the early check formData() would wait for a body
    // that never comes, so a quick 413 proves the refusal happens before the body is read
    const before = capped.uploads.length
    const port = cappedServer.port!
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(`POST /api/upload HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: multipart/form-data; boundary=x\r\nContent-Length: ${CAP + 1}\r\nConnection: close\r\n\r\n`)
      })
      socket.setTimeout(5000)
      let out = ''
      socket.on('data', (d) => {
        out += d.toString()
      })
      socket.on('timeout', () => {
        socket.destroy()
        reject(new Error('no early answer'))
      })
      socket.on('end', () => resolve(out))
      socket.on('error', reject)
    })
    expect(raw).toStartWith('HTTP/1.1 413')
    expect(JSON.parse(raw.split('\r\n\r\n')[1])).toEqual({ error: UPLOAD_TOO_LARGE })
    expect(capped.uploads.length).toBe(before)
  })

  test('a streamed body with no content-length is refused by the file size too', async () => {
    const before = capped.uploads.length
    const boundary = 'uploadcap'
    const enc = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.png"\r\n\r\n`))
        c.enqueue(new Uint8Array(CAP + 1))
        c.enqueue(enc.encode(`\r\n--${boundary}--\r\n`))
        c.close()
      },
    })
    const r = await fetch(`${cappedBase}/api/upload`, { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body })
    expect(r.status).toBe(413)
    expect(await r.json()).toEqual({ error: UPLOAD_TOO_LARGE })
    expect(capped.uploads.length).toBe(before)
  })

  test('a file under the cap still reaches the source and answers with its path', async () => {
    const before = capped.uploads.length
    const r = await postFile(64)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ path: '/inbox/c/big.png' })
    expect(capped.uploads.length).toBe(before + 1)
    expect(capped.uploads.at(-1)).toEqual({ chat: 'c', name: 'big.png', size: 64 })
  })
})

describe('adding a space', () => {
  test("folders are listed for the app's own page, never for another website", async () => {
    const r = await fetch(`${base}/api/folders?machine=mac&path=${encodeURIComponent('~')}`, { headers: { 'sec-fetch-site': 'same-origin' } })
    expect(await r.json()).toMatchObject({ path: '~', machine: 'mac', entries: [{ name: 'dev' }] })
    expect((await fetch(`${base}/api/folders?path=~`, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    expect((await fetch(`${base}/api/folders?path=~`, { headers: { origin: 'https://evil.example' } })).status).toBe(403)
  })
  test('a refused path says why', async () => {
    const r = await fetch(`${base}/api/folders?machine=h&path=/etc`)
    expect(r.ok).toBe(false)
    expect(((await r.json()) as { error: string }).error).toBe('Only folders in your home can be added.')
  })
  test('adding needs the app header from a page, and passes on only what it knows', async () => {
    const host = `127.0.0.1:${server.port}`
    const body = JSON.stringify({ machine: 'mac', path: '~/dev/x', name: 'x', create: 1, extra: 'no' })
    expect((await fetch(`${base}/api/spaces`, { method: 'POST', headers: { origin: `http://${host}` }, body })).status).toBe(403)
    const r = await fetch(`${base}/api/spaces`, { method: 'POST', headers: { origin: `http://${host}`, 'x-shepherdr': '1' }, body })
    expect(await r.json()).toEqual({ place: 'p:h:x' })
    expect(acted.at(-1)).toEqual({ machine: 'mac', path: '~/dev/x', name: 'x', create: true })
  })
})

describe("a task's worktree", () => {
  test("read by the app's own page, never by another website; it asks only for what the panel knows", async () => {
    const r = await fetch(`${base}/api/worktree?task=GTM-1&what=file&path=src/a.ts`, { headers: { 'sec-fetch-site': 'same-origin' } })
    expect(await r.json()).toEqual({ asked: { task: 'GTM-1', what: 'file', path: 'src/a.ts' } })
    expect((await fetch(`${base}/api/worktree?task=GTM-1&what=files`, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    expect((await fetch(`${base}/api/worktree?task=GTM-1&what=files`, { headers: { origin: 'https://evil.example' } })).status).toBe(403)
    expect((await fetch(`${base}/api/worktree?task=GTM-1&what=rm`)).status).toBe(400)
    const bad = await fetch(`${base}/api/worktree?task=GTM-1&what=file&path=../x`)
    expect(((await bad.json()) as { error: string }).error).toBe('No such file.')
  })
})

describe('artifacts', () => {
  test('a page is served sealed: its own origin never, nothing loaded from anywhere, its data inert inside', async () => {
    const r = await fetch(`${base}/api/artifacts/ab12?v=1&full=1&device=phone`)
    expect(r.status).toBe(200)
    const csp = r.headers.get('content-security-policy')!
    expect(csp).toStartWith('sandbox allow-scripts allow-forms;')
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("connect-src 'none'")
    expect(csp).not.toContain('https:')
    const html = await r.text()
    expect(html).toContain('<h1>v1</h1>')
    expect(html).toContain('class="full phone"')
    // the data can't close the script it sits in
    expect(html).not.toContain('</script><script>alert(1)')
    expect(html).toContain('\\u003c/script>')
  })
  test('its data alone, its picture, and nothing for an artifact that is not there', async () => {
    expect(await (await fetch(`${base}/api/artifacts/ab12/data?v=2`)).json()).toEqual({ data: { n: '</script><script>alert(1)</script>' } })
    const t = await fetch(`${base}/api/artifacts/ab12/thumb`)
    expect(t.headers.get('content-type')).toBe('image/png')
    expect((await fetch(`${base}/api/artifacts/zz99`)).status).toBe(404)
    expect((await fetch(`${base}/api/artifacts/zz99/thumb`)).status).toBe(404)
  })
})
