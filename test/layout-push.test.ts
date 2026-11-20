// When the browser drops a push subscription (a cleared profile, revoked permission, an expired service), the next
// load tells the server to forget that device. When the browser still holds one, the endpoint is remembered so a
// later load can tell the difference. The alerts plugin does both in its start (plugins/alerts/client.tsx).
import { expect, test } from 'bun:test'
import { layout, until } from './layout.ts'

const { browser, url } = await layout()

test('a browser that lost its subscription removes its device on the next load', async () => {
  if (!browser) return
  const page = await browser.newPage()
  const removed: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'DELETE' && new URL(r.url()).pathname.endsWith('/api/push/subscribe')) removed.push(r.postData() ?? '')
  })
  await page.addInitScript(() => localStorage.setItem('shepherdr.push.endpoint', 'https://push.example/old'))
  await page.goto(url())
  await until(
    async () => removed.length,
    (n) => n > 0,
  )
  expect(JSON.parse(removed[0] ?? 'null')).toEqual({ endpoint: 'https://push.example/old' })
  expect(await page.evaluate(() => localStorage.getItem('shepherdr.push.endpoint'))).toBeNull()
  await page.close()
})

test('a browser that still holds a subscription remembers its endpoint', async () => {
  if (!browser) return
  const page = await browser.newPage()
  await page.addInitScript(() => {
    Object.defineProperty(navigator.serviceWorker, 'register', {
      configurable: true,
      value: async () => ({ pushManager: { getSubscription: async () => ({ endpoint: 'https://push.example/current' }) } }),
    })
  })
  await page.goto(url())
  const kept = await until(
    () => page.evaluate(() => localStorage.getItem('shepherdr.push.endpoint')),
    (v) => v === 'https://push.example/current',
  )
  expect(kept).toBe('https://push.example/current')
  await page.close()
})
