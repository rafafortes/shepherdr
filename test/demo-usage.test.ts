// The demo fixture behind Settings → Models → Summary must read the same whatever hour it is opened at. At base 8aabbc3b
// its working-hour calls let the "Out until" row come back during 09-18 (SHE-167's outState; SHE-98's repair already
// landed on herdr-tui). This pins that repair across every hour and minute, in every time zone.
import { describe, expect, test } from 'bun:test'
import { demoUsage } from '../server/demo/usage.ts'

const KEY = 'pi.opencode-go/deepseek-v4.1-flash'
const PROVIDER = KEY.slice(0, KEY.indexOf('/'))

describe('the demo usage fixture', () => {
  test('the out-now row stays out, until a future reset, with two run-outs, at every hour of the day', () => {
    for (let hour = 0; hour < 24; hour++) {
      for (const minute of [0, 45]) {
        const now = new Date(2026, 10, 20, hour, minute, 0, 0).getTime()
        const usage = demoUsage(now)
        const st = usage.outOf(PROVIDER, now)
        expect(st.out, `out at ${hour}:${minute}`).toBe(true)
        expect(st.last?.resetAt, `reset ahead of now at ${hour}:${minute}`).toBeGreaterThan(now)
        expect(
          usage.runOuts((k) => k === KEY),
          `two run-outs at ${hour}:${minute}`,
        ).toHaveLength(2)
      }
    }
  })
})
