// Can a browser test open a browser on this machine? Playwright's Chromium (its headless shell, for every browser
// test) and WebKit (Safari's engine, for the iPhone tests), from the playwright-core this checkout has, plus the
// system libraries WebKit needs. A browser test skips where its browser won't start (test/chromium.ts), so the local
// check opens both first and names what to install instead of passing a quieter run (scripts/check-local.sh).
//
//   bun scripts/check-browsers.ts      # one line per engine: "ok", or what to run
import { chromium, webkit, type BrowserType } from 'playwright-core'

const line = (name: string, text: string) => console.log(`${name}: ${text}`)

async function probe(name: string, browser: BrowserType, install: string, deps?: string) {
  const t0 = Date.now()
  try {
    const b = await browser.launch()
    const version = b.version()
    await b.close()
    line(name, `ok (${version}, ${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  } catch (e) {
    const said = (e as Error).message.split('\n')[0]!.replace(/^[\w.]+: /, '').trim()
    // the browser isn't downloaded: a download of its own, no root
    if (/Executable doesn't exist/i.test(said)) line(name, `not installed: ${install}`)
    // it is there but something it links against isn't: its system libraries, from apt (root)
    else line(name, `can't start (${said}): ${deps ?? install}`)
  }
}

// the headless shell alone: what a headless browser test uses (the full Chromium is for a screen with a window)
await probe('chromium', chromium, 'bun x playwright-core install --only-shell chromium', 'sudo bun x playwright-core install-deps chromium')
await probe('webkit', webkit, 'bun x playwright-core install webkit', 'sudo bun x playwright-core install-deps webkit')
