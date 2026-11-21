// The performance history (server/live/health.ts): a bounded ring of what this server's own numbers were, kept in
// health.json with the machine watch, and the block `shepherdr doctor` prints from it.
import { describe, expect, test } from 'bun:test'
import type { HealthKept, PerfSample } from '../server/live/health.ts'
import { tmp } from './tmp.ts'

process.env.SHEPHERDR_HOME = tmp('perf-history')
const H = await import('../server/live/health.ts')
const { Settings } = await import('../server/live/settings.ts')

const limits = () => new Settings().machine()
const DAY = 86_400_000
const MB = 2 ** 20

/** one line of the ring, with only what a test cares about set */
const line = (at: number, extra: Partial<PerfSample> = {}): PerfSample => ({ at, load: 1, memUsed: 8 * 2 ** 30, rss: 300 * MB, lag: 0, stalls: 0, working: 0, ...extra })

/** a machine's sample, as the monitor takes it */
const machine = (at = 0) => ({ at, cores: 16, load: 1, memUsed: 8 * 2 ** 30, memTotal: 32 * 2 ** 30, disks: [], gpus: [] })

describe('the ring', () => {
  test('a week of samples at three resolutions, never more than PERF_KEEP entries', () => {
    const start = Date.UTC(2026, 10, 1)
    let ring: PerfSample[] = []
    const n = 20_000 // 6.9 days at one every 30 s
    for (let i = 0; i < n; i++) ring = H.keepPerf([...ring, line(start + i * 30_000)], start + i * 30_000)
    const now = start + (n - 1) * 30_000 // the last sample taken
    expect(ring.length).toBeLessThanOrEqual(H.PERF_KEEP)
    expect(ring.at(-1)?.at).toBe(now)
    // the last hour as it was taken
    const recent = ring.filter((s) => s.at > now - H.PERF_RECENT_MS)
    expect(recent.length).toBeGreaterThan(100)
    expect(recent.every((s) => s.n === undefined)).toBe(true)
    // the day before it, one every 5 minutes
    // (a sample just below the hour's edge is still one as taken: the bucket edge is up to 5 minutes under it)
    const day = ring.filter((s) => s.at <= now - H.PERF_RECENT_MS - 300_000 && s.at > now - DAY)
    expect(day.length).toBeGreaterThan(200)
    expect(day.every((s) => s.at % 300_000 === 0)).toBe(true)
    // and the rest of the week, one every 30 minutes
    const week = ring.filter((s) => s.at <= now - DAY)
    expect(week.length).toBeGreaterThan(200)
    expect(week.every((s) => s.at % 1_800_000 === 0)).toBe(true)
    // the oldest kept is a week back; a sample as it was taken never survives it
    expect(now - ring[0].at).toBeGreaterThan(6 * DAY)
    expect(ring.find((s) => s.at < now - DAY)?.n).toBeGreaterThan(1)
  })

  test('a bucket keeps the worst lag and the slowest pass, adds the stalls up, and says how many it stands for', () => {
    const now = Date.UTC(2026, 10, 18, 12)
    const at = now - 2 * 3_600_000 // two hours back: a 5-minute bucket
    const ring = [
      line(at, { lag: 900, stalls: 1, rss: 100 * MB, working: 1, pass: { label: 'snapshot', ms: 300 } }),
      line(at + 30_000, { lag: 120, stalls: 2, rss: 200 * MB, working: 3, pass: { label: 'pollChats', ms: 500 } }),
      line(at + 60_000, { lag: 60, stalls: 0, rss: 150 * MB, working: 2 }),
    ]
    const kept = H.keepPerf(ring, now)
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatchObject({
      at: Math.floor(at / 300_000) * 300_000,
      lag: 900,
      stalls: 3,
      rss: 200 * MB,
      working: 3,
      n: 3,
      pass: { label: 'pollChats', ms: 500 },
    })
  })

  test('the cap drops the oldest entries first', () => {
    const now = Date.UTC(2026, 10, 18, 12)
    const ring = Array.from({ length: 1000 }, (_, i) => line(now - (999 - i) * 3_000)) // all within the last hour: none thinned
    const kept = H.keepPerf(ring, now)
    expect(kept).toHaveLength(H.PERF_KEEP)
    expect(kept.at(-1)).toBe(ring.at(-1))
    expect(kept[0]).toBe(ring[300])
  })
})

describe('kept in health.json', () => {
  test("a sample every 30 seconds with this server's own numbers, written with the watch, and read back after a restart", () => {
    let kept: HealthKept = {}
    const writes: HealthKept[] = []
    const store = {
      read: () => kept,
      write: (k: HealthKept) => {
        kept = k
        writes.push(k)
      },
    }
    const monitor = () =>
      new H.Monitor(
        limits,
        () => true,
        () => undefined,
        () => machine(0),
        store,
      )
    const mon = monitor()
    mon.perfNow = () => ({ lag: 1200, stalls: 2, working: 3, pass: { label: 'snapshot', ms: 250 } })
    mon.tick(0)
    mon.tick(5_000) // a tick between samples takes none: the same numbers are not counted twice
    expect(mon.samples).toHaveLength(1)
    mon.tick(30_000)
    expect(mon.samples).toHaveLength(2)
    expect(mon.samples[1]).toMatchObject({ at: 30_000, load: 1, lag: 1200, stalls: 2, working: 3, pass: { label: 'snapshot', ms: 250 } })
    expect(mon.samples[1].rss).toBeGreaterThan(0)
    // one write holds both the watch and the ring
    expect(writes.at(-1)).toEqual({ watch: {}, samples: mon.samples })
    // a restart reads them back
    expect(monitor().samples).toEqual(mon.samples)
  })

  test('a health.json from before the ring, with the watch alone at its top, is still read', () => {
    const kept = { memory: { since: 5, told: true } } as unknown as HealthKept
    const mon = new H.Monitor(
      limits,
      () => true,
      () => undefined,
      () => machine(0),
      { read: () => kept, write: () => undefined },
    )
    expect(mon.told()).toEqual({ memory: { since: 5, told: true } })
    expect(mon.samples).toEqual([])
  })
})

describe("doctor's block", () => {
  /** a day as doctor labels it, in this machine's own time */
  const label = (t: number) => {
    const d = new Date(t)
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  test("each day's worst lag, the last hour's p95, the server's memory now and a day and a week ago, and the slowest passes", () => {
    const now = Date.UTC(2026, 10, 18, 12)
    const ring = [
      line(now - 7 * DAY - 60_000, { rss: 200 * MB, lag: 10 }),
      line(now - DAY - 60_000, { rss: 300 * MB, lag: 2400 }),
      line(now - 60_000, { rss: 400 * MB, lag: 30, stalls: 2, pass: { label: 'snapshot', ms: 900 } }),
      line(now - 30_000, { rss: 410 * MB, lag: 40, stalls: 1, pass: { label: 'pollChats', ms: 150 } }),
    ]
    const text = H.perfReport(ring, now).join('\n')
    expect(text).toContain('Performance:')
    expect(text).toContain('4 samples')
    // the day's worst, not a p95 of entries of different resolutions, and the last hour's p95 as it was taken
    expect(text).toContain(`worst by day ${label(now - 7 * DAY)} 10 ms, ${label(now - DAY)} 2.4 s and today 40 ms; last hour p95 40 ms`)
    expect(text).toContain('stalls in the last day: 3')
    expect(text).toContain('memory in use by the server: now 410 MB · 24 h ago 300 MB · 7 d ago 200 MB')
    expect(text).toContain('slowest passes in the last day: snapshot 900 ms, pollChats 150 ms')
    // nothing kept is nothing said, and a ring of one sample says only what it can
    expect(H.perfReport([], now)).toEqual([])
    const one = H.perfReport([line(now - 1_000, { rss: 512 * MB })], now).join('\n')
    expect(one).toContain('1 sample, back to')
    expect(one).toContain('memory in use by the server: now 512 MB')
    expect(one).not.toContain('24 h ago')
    expect(one).not.toContain('slowest passes')
    // a sample 30 hours old is not called "24 h ago": nothing within a couple of hours of that age, nothing said
    const gap = H.perfReport([line(now - 30 * 3_600_000, { rss: 256 * MB }), line(now - 30_000, { rss: 512 * MB })], now).join('\n')
    expect(gap).not.toContain('24 h ago')
  })
})

describe('through health.json on disk', () => {
  test('the ring is written compact with the watch, capped on the way in, and read back by the next server', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { readJson, writeJson } = await import('../server/store.ts')
    const dir = tmp('perf-json')
    const store = { read: () => readJson<HealthKept>('health.json', {}, dir), write: (k: HealthKept) => writeJson('health.json', k, dir, true) }
    const monitor = () =>
      new H.Monitor(
        limits,
        () => true,
        () => undefined,
        () => machine(0),
        store,
      )
    const mon = monitor()
    mon.perfNow = () => ({ lag: 90, stalls: 1, working: 2 })
    mon.tick(0)
    mon.tick(30_000)
    const file = join(dir, 'health.json')
    const bytes = readFileSync(file, 'utf8')
    expect(bytes).not.toContain('\n  "at"') // compact: the file is machine state, not something to read
    expect(JSON.parse(bytes)).toMatchObject({ watch: {}, samples: [{ at: 0 }, { at: 30_000, lag: 90, stalls: 1, working: 2 }] })
    // the next server reads the same ring back
    expect(monitor().samples).toHaveLength(2)
    // a file holding more than the cap keeps its newest PERF_KEEP entries
    const older = Array.from({ length: H.PERF_KEEP + 50 }, (_, i) => line(1_000_000 + i * 1_000))
    writeJson('health.json', { watch: { cpu: { since: 1, told: true } }, samples: older }, dir, true)
    const reopened = monitor()
    expect(reopened.samples).toHaveLength(H.PERF_KEEP)
    expect(reopened.samples.at(-1)?.at).toBe(older.at(-1)?.at)
    expect(reopened.told()).toEqual({ cpu: { since: 1, told: true } })
  })
})
