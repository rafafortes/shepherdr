// The app's own pages carry an enforcing CSP; artifacts and attachments keep their own stricter sandbox.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { APP_CSP, startApp } from '../server/app.ts'
import { Emitter, type Source, type SourceEvents } from '../server/source.ts'
import { tmp } from './tmp.ts'

class Stub extends Emitter<SourceEvents> {
  kind = 'demo' as const
  snapshot() {
    return { name: 'x', host: 'h', places: [], tasks: [], automations: {}, artifacts: [], asks: {}, settings: [], user: 'u' }
  }
  watch() {}
  async artifact(id: string) {
    return id === 'a1' ? { html: '<h1>an artifact</h1>', data: null, sent: undefined } : undefined
  }
}

const dir = tmp('app-headers')
const dist = join(dir, 'dist')
mkdirSync(join(dist, 'assets'), { recursive: true })
writeFileSync(join(dist, 'index.html'), '<!doctype html><script src="./theme.js"></script><script type="module" src="./assets/index-AbC123.js"></script>')
writeFileSync(join(dist, 'theme.js'), 'document.documentElement.dataset.theme = "light"')
writeFileSync(join(dist, 'assets', 'index-AbC123.js'), 'console.log("the app")')

const app = startApp({ source: new Stub() as unknown as Source, dist, port: 0 })
afterAll(() => app.stop(true))
const base = `http://127.0.0.1:${app.port}`

describe('the app pages', () => {
  test('the page and every static file answer with the same enforcing CSP', async () => {
    for (const path of ['/', '/index.html', '/theme.js', '/assets/index-AbC123.js']) {
      const r = await fetch(base + path)
      expect(r.status).toBe(200)
      expect(r.headers.get('content-security-policy')).toBe(APP_CSP)
      // an enforcing header, never report-only
      expect(r.headers.get('content-security-policy-report-only')).toBeNull()
    }
  })

  test('the policy holds code, media and calls to this origin, refuses framing and plugin-like content', () => {
    const by = new Map(APP_CSP.split('; ').map((d) => [d.split(' ')[0], d]))
    expect(by.get('default-src')).toBe("default-src 'self'")
    expect(by.get('script-src')).toBe("script-src 'self'")
    expect(by.get('style-src')).toBe("style-src 'self' 'unsafe-inline'")
    expect(by.get('img-src')).toBe("img-src 'self' data: blob:")
    expect(by.get('media-src')).toBe("media-src 'self' blob:")
    expect(by.get('font-src')).toBe("font-src 'self'")
    // the socket, the API and push registration stay here; the service worker and artifact frames do too. The browser
    // panel's streamed frames are decoded from a data URL (plugins/browser/client.tsx), so data: is needed as well.
    expect(by.get('connect-src')).toBe("connect-src 'self' data:")
    expect(by.get('worker-src')).toBe("worker-src 'self'")
    expect(by.get('frame-src')).toBe("frame-src 'self'")
    expect(by.get('frame-ancestors')).toBe("frame-ancestors 'self'")
    expect(by.get('base-uri')).toBe("base-uri 'none'")
    expect(by.get('object-src')).toBe("object-src 'none'")
    expect(by.get('form-action')).toBe("form-action 'none'")
  })

  test('an artifact keeps its own stricter sandbox, not the app policy', async () => {
    const r = await fetch(`${base}/api/artifacts/a1`)
    expect(r.status).toBe(200)
    const csp = r.headers.get('content-security-policy')!
    expect(csp).toStartWith('sandbox allow-scripts allow-forms;')
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("frame-ancestors 'self'")
    expect(csp).not.toBe(APP_CSP)
  })
})
