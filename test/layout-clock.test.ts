// Relative-time labels keep moving on the screen's own clock, with no new snapshot and no real wait: the regression
// SHE-105 left behind (f22d0997). Playwright's fake clock advances Date and fires the screen's real interval, so this
// checks a countdown, an age, and that the tree around them and the snapshot revision did not move.
import { describe, expect, test } from 'bun:test'
import { layout } from './layout.ts'

const { browser, world, server, url } = await layout()

describe.skipIf(!browser)('relative times tick on the shared clock', () => {
  test('a working line counts down and then reads its age when the clock moves, with no new revision or tree render', async () => {
    if (!browser) return
    const minute = 60_000
    // pin the agent's report to a whole minute so every displayed number is exact: said "15 min left" three minutes
    // ago, so the screen reads "12m" now. The raw timestamp is what the live source sends with every report.
    const base = Math.floor(Date.now() / minute) * minute
    const working = world.tasks.find((t) => t.id === 'HP-202')
    if (!working) throw new Error('HP-202 is missing from the demo world')
    working.report = { msg: 'Tracing why mute ends the call', progress: 40, eta: 12, at: base - 3 * minute, left: 15 }
    ;(world as unknown as { emit(e: string): void }).emit('snapshot')

    // a second socket sees the same broadcasts, so the test can prove the clock moved the label without a new revision
    const observer = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws`)
    const revs: number[] = []
    observer.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as { type: string; snapshot?: { rev?: number } }
      if (msg.type === 'snapshot') revs.push(msg.snapshot?.rev ?? 0)
    }
    await new Promise<void>((r) => (observer.onopen = () => r()))
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    try {
      // install before the page loads: this drives the interval the app itself uses, not a test-only setter
      await page.clock.install({ time: base })
      await page.goto(`${url()}&tab=tasks`)
      const row = page.getByRole('button', { name: /HP-202 Voice/ })
      await row.waitFor()
      await row.getByText('12m', { exact: true }).waitFor()
      // let anything queued while the page opened land before measuring what the clock alone changes
      await Bun.sleep(100)
      const settled = revs.length
      await page.evaluate(() => {
        ;(window as unknown as { shepRenderCount: Record<string, number> }).shepRenderCount = {}
      })

      // four minutes later, still inside the five-minute cadence: the same snapshot reads "8m"
      await page.clock.fastForward(4 * minute)
      await row.getByText('8m', { exact: true }).waitFor()
      const renders = await page.evaluate(() => ({ ...(window as unknown as { shepRenderCount: Record<string, number> }).shepRenderCount }))
      expect(renders.app ?? 0).toBe(0)
      expect(revs.length).toBe(settled)

      // past the cadence, the countdown gives way to the line's age: "11m ago", still on the same revision
      await page.clock.fastForward(4 * minute)
      await row.getByText(/11m ago/).waitFor()
      expect(revs.length).toBe(settled)
    } finally {
      observer.close()
      await page.close()
    }
  }, 60_000)
})
