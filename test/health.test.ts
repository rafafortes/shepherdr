// Machine health: reading /proc and nvidia-smi, when a limit is told (once, and again once it is back under), what
// holds new tasks, and the numbers each machine's Settings note gives (server/live/health.ts).
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'

const perl = spawnSync('perl', ['-e1']).status === 0

process.env.SHEPHERDR_HOME = tmp('health')
const H = await import('../server/live/health.ts')
const { Settings, machineNote } = await import('../server/live/settings.ts')

const limits = () => new Settings().machine()
const at = (load: number, memPct = 40, disk = 50, gpus: { name: string; util: number; memPct: number }[] = []) => ({
  at: 0,
  cores: 16,
  load,
  memTotal: 100 * 2 ** 30,
  memUsed: memPct * 2 ** 30,
  disks: [{ path: '/tmp', pct: disk, freeGb: 100 - disk, dev: 1 }],
  gpus,
})

describe('reading the machine', () => {
  test('/proc/loadavg, /proc/meminfo and nvidia-smi', () => {
    expect(H.parseLoad('27.31 21.63 22.17 29/4304 1205109\n')).toBe(27.31)
    // the 5-minute load, and the CPU pressure a kernel with PSI keeps (none without them)
    expect(H.parseLoad5('27.31 21.63 22.17 29/4304 1205109\n')).toBe(21.63)
    expect(H.parseLoad5('')).toBeUndefined()
    expect(H.parsePressure('some avg10=1.01 avg60=27.40 avg300=5.89 total=7063159309\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n')).toBe(27.4)
    expect(H.parsePressure('')).toBeUndefined()
    // the same line reads memory's and I/O's pressure (/proc/pressure/memory, /proc/pressure/io)
    expect(H.parsePressure('some avg10=1.40 avg60=24.50 avg300=0.90 total=2041250513\nfull avg10=1.40 avg60=24.50 avg300=0.86 total=1891098326\n')).toBe(24.5)
    const m = H.parseMem('MemTotal:       32858064 kB\nMemFree:         3661672 kB\nMemAvailable:   20015576 kB\nSwapTotal:       8388604 kB\nSwapFree:        4194300 kB\n')
    expect(m.total).toBe(32858064 * 1024)
    expect(m.used).toBe((32858064 - 20015576) * 1024)
    // swap in use is what is not free of it; a machine with none (macOS) gives neither number
    expect(m.swapTotal).toBe(8388604 * 1024)
    expect(m.swapUsed).toBe((8388604 - 4194300) * 1024)
    expect(H.parseMem('MemTotal: 1000 kB\nMemAvailable: 400 kB\n')).toMatchObject({ swapTotal: 0, swapUsed: 0 })
    expect(H.parseGpus('NVIDIA A10G, 37, 4096, 23028\n\n')).toEqual([{ name: 'NVIDIA A10G', util: 37, memPct: 18 }])
    expect(H.parseGpus('')).toEqual([])
  })

  test('a real sample of this machine: cores, load, memory and swap, and home and /tmp once each', () => {
    const s = H.sample()
    expect(s.cores).toBeGreaterThan(0)
    expect(s.memTotal).toBeGreaterThan(s.memUsed)
    expect(s.disks.length).toBeGreaterThanOrEqual(1)
    expect(new Set(s.disks.map((d) => d.dev)).size).toBe(s.disks.length)
    expect(H.summary(s)).toMatch(/^CPU \d+% \(load [\d.]+ on \d+ cores( · pressure \d+%)?\) · Memory \d+% \(\d+ GB of \d+ GB( · swap \d+ GB)?( · pressure \d+%)?\)( · I\/O pressure \d+%)? · Disk /)
  })

  test.if(perl)('a box sample from a helper that predates the fields keeps them undefined', () => {
    const home = tmp('health-old-helper')
    const helper = join(home, '.shepherdr', 'helper')
    mkdirSync(helper, { recursive: true })
    // what helper/health.pl printed before swap and the memory and I/O pressure were added
    const old = { cores: 4, load: 1.2, load5: 1.1, cpuSome: 5, memTotal: 8 * 2 ** 30, memUsed: 3 * 2 ** 30, disks: [{ path: '/home/old', pct: 42, freeGb: 10, dev: 99 }], gpus: [] }
    writeFileSync(join(helper, 'health.pl'), `print '${JSON.stringify(old)}', "\\n";\n`)
    const s = H.boxSample({ label: 'old', target: 'old.invalid', session: 'default', herdr: 'herdr', home, path: '/usr/bin', os: 'Linux' })
    // the fields ride the JSON as it is: an old helper simply leaves them out, and the main machine reads none of them
    expect(s.ioSome).toBeUndefined()
    expect(s.memSome).toBeUndefined()
    expect(s.swapTotal).toBeUndefined()
    expect(s.swapUsed).toBeUndefined()
    expect(s.cpuSome).toBe(5)
    expect(s.load).toBe(1.2)
    expect(s.disks[0].path).toBe('/home/old')
    // its line and meters do not break or invent an I/O reading; a limit there cannot hold a machine that gives none
    expect(H.summary(s)).not.toContain('I/O pressure')
    expect(H.meters(s, limits(), {}).map((m) => m.name)).toEqual(['CPU', 'Memory', 'Disk'])
    expect(H.busy(s, { ...limits(), startIoPressure: 25 })).toBeUndefined()
  })

  test.if(perl)("a box sample carries a current helper's pressure and swap fields through", () => {
    const home = tmp('health-current-helper')
    const helper = join(home, '.shepherdr', 'helper')
    mkdirSync(helper, { recursive: true })
    const current = {
      cores: 8,
      load: 2.4,
      load5: 2.1,
      cpuSome: 31,
      memSome: 24,
      ioSome: 28,
      memTotal: 16 * 2 ** 30,
      memUsed: 10 * 2 ** 30,
      swapTotal: 2 * 2 ** 30,
      swapUsed: 1 * 2 ** 30,
      disks: [{ path: '/home/current', pct: 60, freeGb: 20, dev: 42 }],
      gpus: [],
    }
    writeFileSync(join(helper, 'health.pl'), `print '${JSON.stringify(current)}', "\\n";\n`)
    const s = H.boxSample({ label: 'current', target: 'current.invalid', session: 'default', herdr: 'herdr', home, path: '/usr/bin', os: 'Linux' })
    expect(s.ioSome).toBe(28)
    expect(s.memSome).toBe(24)
    expect(s.swapTotal).toBe(2 * 2 ** 30)
    expect(s.swapUsed).toBe(1 * 2 ** 30)
    expect(H.summary(s)).toContain('I/O pressure 28%')
    expect(H.meters(s, limits(), {}).map((m) => m.name)).toContain('I/O')
  })
})

describe('the GPU read is async', () => {
  const script = (dir: string, name: string, body: string) => {
    const path = join(dir, name)
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    return path
  }
  const lines = 'NVIDIA A10G, 37, 4096, 23028'

  test('a fake nvidia-smi is read with Bun.spawn, and a missing one is looked up once then cached', async () => {
    const dir = tmp('health-gpus')
    expect(await H.gpusAsync(script(dir, 'smi', `printf '${lines}\\n'`))).toEqual([{ name: 'NVIDIA A10G', util: 37, memPct: 18 }])
    // stub the lookup so this says the same on a machine with a GPU as on one without (the Radeon here)
    const which = Bun.which
    let lookups = 0
    Bun.which = (() => {
      lookups++
      return null
    }) as typeof Bun.which
    try {
      expect(await H.gpusAsync()).toEqual([])
      expect(await H.gpusAsync()).toEqual([])
      expect(lookups).toBe(1) // a miss is cached, not looked up again on every sample
    } finally {
      Bun.which = which
    }
    expect(await H.gpusAsync('')).toEqual([])
  })

  test('a failed, absent or hanging nvidia-smi misses; a hang settles well under the stall threshold', async () => {
    const dir = tmp('health-gpus-slow')
    expect(await H.gpusAsync(script(dir, 'bad', 'exit 1'))).toBeNull()
    expect(await H.gpusAsync(join(dir, 'not-there'))).toBeNull()
    const t0 = Date.now()
    expect(await H.gpusAsync(script(dir, 'slow', 'exec sleep 5'))).toBeNull()
    expect(Date.now() - t0).toBeLessThan(2500)
  })

  test('the sync sample spawns nothing; tick uses the real async reader and keeps the last reading on a miss', async () => {
    const real = Bun.spawnSync
    let sync = 0
    Bun.spawnSync = ((...a: Parameters<typeof Bun.spawnSync>) => {
      sync++
      return real(...a)
    }) as typeof Bun.spawnSync
    try {
      expect(H.sample().gpus).toEqual([])
    } finally {
      Bun.spawnSync = real
    }
    expect(sync).toBe(0)

    const dir = tmp('health-gpus-tick')
    const gpu = [{ name: 'NVIDIA A10G', util: 37, memPct: 18 }]
    let shown = 0
    const mon = new H.Monitor(
      limits,
      () => true,
      () => undefined,
      undefined,
      undefined,
      () => shown++,
    )
    mon.readGpus = () => H.gpusAsync(script(dir, 'smi', `printf '${lines}\\n'`)) // the default reader, pointed at a fake smi
    const t0 = Date.now()
    mon.tick(0)
    expect(Date.now() - t0).toBeLessThan(200)
    for (let i = 0; i < 50 && !mon.last?.gpus.length; i++) await Bun.sleep(10) // let the async read land, however long the spawn takes
    expect(mon.last?.gpus).toEqual(gpu)
    expect(shown).toBe(1) // the screen is told when the number lands, not one sample late
    // a miss leaves the previous reading and tells nothing; a hung read cannot hold the tick either
    mon.readGpus = async () => null
    mon.tick(31_000)
    expect(mon.last?.gpus).toEqual(gpu)
    expect(shown).toBe(1)
    mon.readGpus = () => new Promise<never>(() => undefined)
    const t1 = Date.now()
    mon.tick(62_000)
    expect(Date.now() - t1).toBeLessThan(200)
    expect(mon.last?.gpus).toEqual(gpu)
  })

  test("a sample that brings its own GPUs (a box worker's remote machine) is not overwritten by a local read", async () => {
    const remote = [{ name: 'REMOTE RTX', util: 55, memPct: 7 }]
    let reads = 0
    const mon = new H.Monitor(
      limits,
      () => true,
      () => undefined,
      () => ({ ...at(1), gpus: remote }),
    )
    mon.readGpus = async () => {
      reads++
      return []
    }
    mon.tick(0)
    await Bun.sleep(20)
    expect(mon.last?.gpus).toEqual(remote)
    expect(reads).toBe(0)
  })
})

describe('limits', () => {
  test('defaults: 10 at once, start under 1× cores and 80% memory; told at 1.5× cores, 90% memory and disk, herdr', () => {
    expect(limits()).toEqual({
      max: 10,
      startLoad: 1,
      startPressure: null,
      startMemoryPressure: null,
      startIoPressure: null,
      startEvery: 2,
      startMemory: 80,
      startSwap: null,
      alertLoad: 1.5,
      alertMemory: 90,
      alertDisk: 90,
      alertHerdr: true,
    })
    const s = new Settings()
    // any number in range, not a fixed list
    expect(s.set('machine.maxTasks', '13').ok).toBe(true)
    expect(s.machine().max).toBe(13)
    for (const bad of ['2.5', '201', 'lots', '-1']) expect(s.set('machine.maxTasks', bad).ok).toBe(false)
    // 0 is a limit of its own (no task starts here), and off is no cap at all
    expect(s.set('machine.maxTasks', '0').ok).toBe(true)
    expect(s.machine().max).toBe(0)
    expect(s.set('machine.maxTasks', 'off').ok).toBe(true)
    expect(s.machine().max).toBeNull()
    s.set('machine.maxTasks', null)
    expect(s.set('machine.startLoad', '1.15x').ok).toBe(true)
    expect(s.get('machine.startLoad')).toBe('1.15× cores')
    expect(s.set('machine.startMemory', '77 %').ok).toBe(true)
    expect(s.machine()).toMatchObject({ startLoad: 1.15, startMemory: 77 })
    expect(s.set('machine.startMemory', 'off').ok).toBe(false)
    s.set('machine.startLoad', null)
    s.set('machine.startMemory', null)
    expect(s.set('machine.alertDisk', 'off').ok).toBe(true)
    expect(s.machine().alertDisk).toBeNull()
    s.set('machine.alertDisk', null)
  })

  test('new tasks wait over a start limit, scaled to the cores', () => {
    const l = limits()
    expect(H.busy(at(15.9), l)).toBeUndefined()
    expect(H.busy(at(16.1), l)).toBe('cpu')
    expect(H.busy(at(2, 81), l)).toBe('memory')
    expect(H.busy(undefined, l)).toBeUndefined()
    expect(H.busy(at(40, 99), { ...l, startLoad: null, startMemory: null })).toBeUndefined()
  })

  test("the load limit reads the 5-minute load, which a burst's lull doesn't bring under; CPU pressure holds starts once set", () => {
    const l = limits()
    // a lull in the 1-minute load while the 5-minute one is still over: starts wait (the 1-minute one let them in)
    expect(H.busy({ ...at(7), load5: 40 }, l)).toBe('cpu')
    // a short burst over a quiet five minutes: they go
    expect(H.busy({ ...at(90), load5: 12 }, l)).toBeUndefined()
    // a machine that gives no 5-minute load is read on its 1-minute one, as before
    expect(H.busy(at(16.1), l)).toBe('cpu')
    // CPU pressure: off by default, a share of the last minute once set; none where the kernel keeps none
    expect(l.startPressure).toBeNull()
    expect(H.busy({ ...at(2), load5: 2, cpuSome: 60 }, l)).toBeUndefined()
    const p = { ...l, startPressure: 20 }
    expect(H.busy({ ...at(2), load5: 2, cpuSome: 27.4 }, p)).toBe('cpu')
    expect(H.busy({ ...at(2), load5: 2, cpuSome: 12 }, p)).toBeUndefined()
    expect(H.busy({ ...at(2), load5: 2 }, p)).toBeUndefined()
    const s = new Settings()
    expect(s.set('machine.startPressure', '25%', 'machine').ok).toBe(true)
    expect(s.machine().startPressure).toBe(25)
    expect(s.set('machine.startPressure', 'off', 'machine').ok).toBe(true)
    expect(s.machine().startPressure).toBeNull()
    s.set('machine.startPressure', null, 'machine')
  })

  test('swap, memory pressure and I/O pressure hold starts once set: swap and memory as memory, I/O as its own', () => {
    const l = limits()
    // all three off by default, as the CPU pressure is: a machine thrashing in swap starts tasks as it did before
    expect([l.startSwap, l.startMemoryPressure, l.startIoPressure]).toEqual([null, null, null])
    const thrash = { ...at(2, 43), load5: 2, swapTotal: 128 * 2 ** 30, swapUsed: 57 * 2 ** 30 }
    expect(H.busy(thrash, l)).toBeUndefined()
    // 45% of swap in use with 43% of memory in use: memory is short though its share looks calm
    expect(H.swapPct(thrash)).toBe(45)
    expect(H.busy(thrash, { ...l, startSwap: 20 })).toBe('memory')
    expect(H.busy(thrash, { ...l, startSwap: 50 })).toBeUndefined()
    // no swap at all (macOS): its share is 0, so the limit never holds there
    expect(H.busy({ ...at(2, 43) }, { ...l, startSwap: 1 })).toBeUndefined()
    // memory pressure: the share of the last minute some task waited for memory
    expect(H.busy({ ...at(2), load5: 2, memSome: 24.5 }, { ...l, startMemoryPressure: 20 })).toBe('memory')
    expect(H.busy({ ...at(2), load5: 2, memSome: 12 }, { ...l, startMemoryPressure: 20 })).toBeUndefined()
    expect(H.busy({ ...at(2), load5: 2 }, { ...l, startMemoryPressure: 20 })).toBeUndefined()
    // I/O pressure is a reason of its own: no CPU and no memory of ours waits on it
    expect(H.busy({ ...at(2), load5: 2, ioSome: 33.6 }, { ...l, startIoPressure: 25 })).toBe('io')
    expect(H.busy({ ...at(2), load5: 2, ioSome: 12 }, { ...l, startIoPressure: 25 })).toBeUndefined()
    expect(H.busy({ ...at(2), load5: 2 }, { ...l, startIoPressure: 25 })).toBeUndefined()
    // and each is a setting of its own, a percent or off
    const s = new Settings()
    for (const [key, v] of [
      ['machine.startSwap', 25],
      ['machine.startMemoryPressure', 30],
      ['machine.startIoPressure', 40],
    ] as const) {
      expect(s.set(key, `${v}%`, 'machine').ok).toBe(true)
      expect(s.machine()[key.replace('machine.', '') as 'startSwap']).toBe(v)
      expect(s.set(key, 'off', 'machine').ok).toBe(true)
      s.set(key, null, 'machine')
    }
    expect(s.machine()).toMatchObject({ startSwap: null, startMemoryPressure: null, startIoPressure: null })
  })

  test('swap and the memory and I/O pressure are one kind, told on their start limits, once, after 2 minutes over', () => {
    const l = { ...limits(), startSwap: 25, startMemoryPressure: 20, startIoPressure: 25 }
    let w = {}
    const sample = (over: object) => ({ ...at(1, 43), load5: 1, swapTotal: 100 * 2 ** 30, ...over })
    const step = (over: object, t: number) => {
      const r = H.judge(w, H.levels(sample(over), true, l), t)
      w = r.next
      return r.events.map((e) => `${e.kind} ${e.what}`)
    }
    // a swap-bound machine: nothing before 2 minutes over, as the CPU kind (a swap filling in a burst is no news yet)
    expect(step({ swapUsed: 30 * 2 ** 30 }, 0)).toEqual([])
    expect(step({ swapUsed: 30 * 2 ** 30 }, 119_000)).toEqual([])
    expect(step({ swapUsed: 30 * 2 ** 30 }, 120_000)).toEqual(['pressure over'])
    // told once, and nothing again while it stays short
    expect(step({ swapUsed: 30 * 2 ** 30 }, 200_000)).toEqual([])
    // back only well under 90% of its limit, as the CPU kind: 25% of 25 is not back yet, 22% is
    expect(step({ swapUsed: 25 * 2 ** 30 }, 260_000)).toEqual([])
    expect(step({ swapUsed: 22 * 2 ** 30 }, 320_000)).toEqual(['pressure back'])
    // the one kind covers each measure of it: memory pressure alone, then I/O pressure alone, each told once
    expect(step({ memSome: 24 }, 400_000)).toEqual([])
    expect(step({ memSome: 24 }, 520_000)).toEqual(['pressure over'])
    expect(step({ memSome: 1 }, 580_000)).toEqual(['pressure back'])
    expect(step({ ioSome: 33 }, 640_000)).toEqual([])
    expect(step({ ioSome: 33 }, 760_000)).toEqual(['pressure over'])
    // and it is back only once every limit set is under: I/O still over holds the news, as the state is still the one
    expect(step({ ioSome: 33, memSome: 1 }, 820_000)).toEqual([])
    expect(step({ ioSome: 1, memSome: 1 }, 880_000)).toEqual(['pressure back'])
    // a machine that gives no reading (macOS) has no limit there, whatever is set
    expect(step({}, 1_000_000)).toEqual([])
  })

  test('the load is told after 2 minutes over its limit, once; again only when it is back well under', () => {
    const l = limits()
    let w = {}
    const step = (load: number, t: number, herdr = true) => {
      const r = H.judge(w, H.levels(at(load), herdr, l), t)
      w = r.next
      return r.events.map((e) => `${e.kind} ${e.what}`)
    }
    expect(step(30, 0)).toEqual([])
    expect(step(30, 60_000)).toEqual([])
    // a dip resets the 2 minutes
    expect(step(10, 90_000)).toEqual([])
    expect(step(30, 100_000)).toEqual([])
    expect(step(30, 219_000)).toEqual([])
    expect(step(30, 220_000)).toEqual(['cpu over'])
    expect(step(30, 250_000)).toEqual([])
    // just under 24 is not back yet: under 90% of it is
    expect(step(23, 280_000)).toEqual([])
    expect(step(21, 310_000)).toEqual(['cpu back'])
    expect(step(30, 340_000)).toEqual([])
    // herdr: told after 30 seconds without it
    expect(step(1, 400_000, false)).toEqual([])
    expect(step(1, 430_000, false)).toEqual(['herdr over'])
    expect(step(1, 440_000, true)).toEqual(['herdr back'])
  })

  test('memory and disk are told at once', () => {
    const l = limits()
    const r = H.judge({}, H.levels(at(1, 95, 93), true, l), 0)
    expect(r.events.map((e) => e.kind).sort()).toEqual(['disk', 'memory'])
  })

  test('the meters: amber while new tasks wait, red once told; a GPU where there is one', () => {
    const m = H.meters(at(20, 50, 95, [{ name: 'A10G', util: 12, memPct: 3 }]), limits(), { disk: { since: 0, told: true } })
    expect(m.map((x) => [x.name, x.pct, x.level])).toEqual([
      ['CPU', 125, 'busy'],
      ['Memory', 50, 'ok'],
      ['Disk', 95, 'over'],
      ['GPU', 12, 'ok'],
    ])
    expect(m[0].detail).toBe('load 20.0 on 16 cores')
    // its 5-minute load and pressure, where the machine gives them; amber by what holds starts back
    const n = H.meters({ ...at(8), load5: 21, cpuSome: 27.6 }, limits(), {})
    expect(n[0]).toMatchObject({ detail: 'load 8.0 (5 min 21.0) on 16 cores · pressure 28%', level: 'busy' })
  })

  test('the health line and the Memory meter show swap and the pressure readings, where the machine gives them', () => {
    const l = limits()
    // 43% of memory in use and 45% of swap: the share looks calm where the machine crawls
    const thrash = { ...at(2, 43), swapTotal: 128 * 2 ** 30, swapUsed: 57 * 2 ** 30, memSome: 24, ioSome: 33 }
    expect(H.summary(thrash)).toBe('CPU 13% (load 2.0 on 16 cores) · Memory 43% (43 GB of 100 GB · swap 57 GB · pressure 24%) · I/O pressure 33% · Disk /tmp 50% (50 GB free)')
    const m = H.meters(thrash, l, {})
    expect(m.map((x) => x.name)).toEqual(['CPU', 'Memory', 'I/O', 'Disk'])
    expect(m[1]).toMatchObject({ pct: 43, detail: '43 GB of 100 GB · swap 57 GB · pressure 24%', level: 'ok' })
    expect(m[2]).toMatchObject({ pct: 33, detail: 'the share of the last minute some task waited on I/O', level: 'ok' })
    // a swap or a memory pressure limit holds starts: the one meter goes amber, then red once its coordinator is told
    expect(H.meters(thrash, { ...l, startSwap: 20 }, {})[1].level).toBe('busy')
    expect(H.meters(thrash, { ...l, startSwap: 20 }, { pressure: { since: 0, told: true } })[1].level).toBe('over')
    expect(H.meters(thrash, { ...l, startIoPressure: 25 }, {})[2].level).toBe('busy')
    expect(H.meters(thrash, { ...l, startIoPressure: 25 }, { pressure: { since: 0, told: true } })[2].level).toBe('over')
    // a machine that gives none of them (macOS): no swap, no pressure, and no I/O meter
    const mac = { ...at(2, 43) }
    expect(H.summary(mac)).toBe('CPU 13% (load 2.0 on 16 cores) · Memory 43% (43 GB of 100 GB) · Disk /tmp 50% (50 GB free)')
    expect(H.meters(mac, l, {}).map((x) => x.name)).toEqual(['CPU', 'Memory', 'Disk'])
  })

  test('the watch: what was told is kept, so a restart tells nothing again while it is still over', () => {
    let kept = {}
    const store = { read: () => kept, write: (w: object) => (kept = w) }
    const told: string[] = []
    const mon = () =>
      new H.Monitor(
        limits,
        () => true,
        (e) => told.push(`${e.kind} ${e.what}`),
        () => at(1, 95),
        store,
      )
    mon().tick(0)
    expect(told).toEqual(['memory over'])
    mon().tick(60_000)
    expect(told).toEqual(['memory over'])
  })
})

describe('what uses it most', () => {
  test("each process with its task, by the worktree it runs in, and each task's share", () => {
    const procs = [
      { pid: 1, cpu: 310, rss: 2 * 2 ** 30, cmd: 'bun test', cwd: '/w/she-1/src' },
      { pid: 2, cpu: 90, rss: 2 ** 29, cmd: 'claude', cwd: '/w/she-1' },
      { pid: 3, cpu: 80, rss: 2 ** 28, cmd: 'vite', cwd: '/w/she-2' },
      { pid: 4, cpu: 20, rss: 2 ** 20, cmd: 'sshd', cwd: '/' },
    ]
    const lines = H.procLines(
      procs,
      [
        { id: 'SHE-1', worktree: '/w/she-1' },
        { id: 'SHE-2', worktree: '/w/she-2' },
        { id: 'SHE-3', worktree: '/w/she-1x' },
      ],
      'cpu',
    )
    expect(lines[0]).toBe('Tasks among them: SHE-1 400% CPU, SHE-2 80% CPU.')
    expect(lines).toContain('  310% CPU  bun test  (SHE-1)')
    expect(lines).toContain('  20% CPU  sshd')
  })

  test('this machine, measured over a moment', async () => {
    const top = await H.topProcs('memory', 3, 50)
    expect(top.length).toBeGreaterThan(0)
    expect(top[0].rss).toBeGreaterThan(0)
  })
})

test("each machine's note gives the limits in its own numbers", () => {
  const n = machineNote(limits(), 16, 31)
  expect(n.noteTitle).toBe('Why these defaults')
  expect(n.note).toStartWith('This machine has 16 cores and 31 GB of memory. New tasks wait while 10 are at work, or while the load is over 16 or over 25 GB of memory is in use.')
  expect(n.note).toContain('load stays over 24 for 2 minutes, memory passes 28 GB')
})

test("the note under a machine's limits says what 0 and no cap mean for its tasks", () => {
  const base = limits()
  expect(machineNote({ ...base, max: 0 }, 4, 8).note).toContain('No task starts on this machine: its Max tasks is 0.')
  expect(machineNote({ ...base, max: null, startLoad: null }, 4, 8).note).not.toContain('New tasks wait')
  expect(machineNote({ ...base, max: null }, 4, 8).note).toContain('New tasks wait while the load is over')
})
