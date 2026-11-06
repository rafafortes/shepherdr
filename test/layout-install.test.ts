// The home-screen install behind a login gate (SHE-26, from upstream 36bda623): the manifest link asks for the page's
// credentials, so a gate in front (our lab-ingress basic auth, Cloudflare Access, Authelia) lets the browser read the
// manifest and the app can be added to the home screen; without a manifest there is no home screen, and an iPhone then
// gets no push alerts at all. The other requests the app makes when it starts (the service worker, an icon, the push
// key) carry the login by themselves, being its own origin's: the gate here says so, a real 401 challenge that
// Chromium answers with the credentials a person typed once.
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser } from 'playwright-core'
import { launch } from './chromium.ts'
import { builtScreen } from './web.ts'

const root = join(import.meta.dir, '..')
const USER = 'lab'
const PASS = 'secret'
const dist = await builtScreen()
/** every request that reached the gate: its path, and whether it carried the login */
const seen: { path: string; auth: boolean }[] = []
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}
const login = `Basic ${btoa(`${USER}:${PASS}`)}`

/** the built app behind a login gate, as lab-ingress serves it: the page at the root (the app moves in the query
 *  string), its files beside it, and a 401 with the challenge everywhere else */
const gate = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url)
    const auth = req.headers.get('authorization') === login
    seen.push({ path: url.pathname, auth })
    if (!auth) return new Response('sign in', { status: 401, headers: { 'www-authenticate': 'Basic realm="lab", charset="UTF-8"' } })
    const file = join(dist, url.pathname === '/' ? 'index.html' : url.pathname.slice(1))
    if (!file.startsWith(dist) || !existsSync(file)) return new Response('not here', { status: 404 })
    return new Response(readFileSync(file), { headers: { 'content-type': TYPES[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream' } })
  },
})

const browser: Browser | null = await launch()
afterAll(async () => {
  await browser?.close()
  gate.stop(true)
})

/** what a request read once it starts answering, or its last within the time */
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const end = Date.now() + ms
  let v = await read()
  while (!ok(v) && Date.now() < end) {
    await Bun.sleep(50)
    v = await read()
  }
  return v
}

describe.skipIf(!browser)('a home-screen install behind the login', () => {
  test("the manifest link asks for the page's credentials, in index.html and in the screen built from it", () => {
    for (const file of [join(root, 'index.html'), join(dist, 'index.html')])
      expect(readFileSync(file, 'utf8')).toMatch(/<link rel="manifest"[^>]*\scrossorigin="use-credentials"/)
  })

  test('the gate lets the browser read the manifest, and everything else the app asks for at start carries the login', async () => {
    const context = await browser!.newContext({ httpCredentials: { username: USER, password: PASS } })
    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:${gate.port}/`)
    // what Add to Home Screen reads: the manifest, with the credentials the person gave the gate
    const cdp = await context.newCDPSession(page)
    const read = await until(async () => (await cdp.send('Page.getAppManifest')) as { data?: string }, (m) => !!m.data)
    // (no credentials, the gate's 401 leaves it empty: no manifest, and nothing to install)
    expect(read.data ?? '').toContain('"name": "Shepherdr"')
    // and whole enough to install: the browser finds nothing missing in it (its name, start_url, display, icons)
    expect((await cdp.send('Page.getInstallabilityErrors')) as { installabilityErrors: unknown[] }).toEqual({ installabilityErrors: [] })
    // the rest of a start, asked for here as the app asks for it (the same origin's requests carry the login by
    // themselves): the service worker alerts need, an icon, the push key, and the subscription it posts. What this gate
    // answers does not matter, only that each request got in; the app's own requests are covered by the log below.
    expect(
      await page.evaluate(async () => ({
        worker: await navigator.serviceWorker.register('sw.js').then(() => true, () => false),
        icon: await fetch('icon-180.png?v=2').then((r) => r.status, () => 0),
        pushKey: await fetch('api/push/key').then(() => true, () => false),
        subscribe: await fetch('api/push/subscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-shepherdr': '1' },
          body: JSON.stringify({ sub: { endpoint: 'https://push.example/1' }, device: 'a test' }),
        }).then(() => true, () => false),
      })),
    ).toEqual({ worker: true, icon: 200, pushKey: true, subscribe: true })
    // every request that reached the gate carried the login, except the one challenge the person answers once
    expect(seen.filter((s) => !s.auth).map((s) => s.path)).toEqual(['/'])
    for (const path of ['/manifest.webmanifest', '/sw.js', '/icon-180.png', '/api/push/key', '/api/push/subscribe'])
      expect(seen).toContainEqual({ path, auth: true })
    // every request that reached the gate carried the login, except the one challenge the person answers once
    expect(seen.filter((s) => !s.auth).map((s) => s.path)).toEqual(['/'])
    for (const path of ['/manifest.webmanifest', '/sw.js', '/icon-180.png', '/api/push/key']) expect(seen).toContainEqual({ path, auth: true })
    await context.close()
  }, 30_000)
})
