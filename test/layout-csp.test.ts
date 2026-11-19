// The app's own CSP, served on its real pages: the screen still loads, its socket connects, the service worker and
// push endpoints still answer, and nothing in the app's own code trips the policy.
import { describe, expect, test } from 'bun:test'
import { layout } from './layout.ts'

const { browser, url } = await layout({ everything: true })

/** a page that records policy violations from before its first script */
async function open() {
  const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } })
  await page.addInitScript(() => {
    const seen: string[] = []
    ;(window as unknown as { cspViolations: string[] }).cspViolations = seen
    document.addEventListener('securitypolicyviolation', (e) => seen.push(`${e.violatedDirective}: ${e.blockedURI}`))
  })
  const errors: string[] = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(url())
  // the places come over /api/ws: the socket connected under connect-src 'self'
  await page.waitForSelector('#places li')
  const violations = () => page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations)
  return { page, errors, violations }
}

describe.skipIf(!browser)('the app under its own CSP', () => {
  test('the page and its socket load with no policy violation of the app\'s own', async () => {
    const { page, errors, violations } = await open()
    const csp = await page.evaluate(() => fetch('./').then((r) => r.headers.get('content-security-policy')))
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("frame-ancestors 'self'")
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light')
    expect(await violations()).toEqual([])
    expect(errors.filter((e) => /content security policy|refused to (load|execute|apply)/i.test(e))).toEqual([])
    await page.close()
  })

  test('the service worker registers and the push endpoints answer from the page', async () => {
    const { page, violations } = await open()
    const got = await page.evaluate(async () => ({
      // worker-src 'self': the alerts service worker is this origin's own file
      worker: await navigator.serviceWorker.register('./sw.js').then(() => true, () => false),
      key: await fetch('./api/push/key').then((r) => r.status, () => 0),
      // the same POST the alerts plugin makes to hand over its subscription, connect-src 'self' and x-shepherdr
      subscribe: await fetch('./api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-shepherdr': '1' },
        body: JSON.stringify({ sub: { endpoint: 'https://push.example/1' }, device: 'a test' }),
      }).then((r) => r.status, () => 0),
    }))
    expect(got).toEqual({ worker: true, key: 200, subscribe: 200 })
    expect(await violations()).toEqual([])
    await page.close()
  })
})
