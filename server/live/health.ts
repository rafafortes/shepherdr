// Machine health: every 30 seconds Shepherdr reads how loaded this machine is (its 1- and 5-minute load against its cores, its CPU, memory
// and I/O pressure, memory and swap in use, how full home and /tmp are, a GPU's use where nvidia-smi is there) and whether herdr answers.
// Cheap: /proc, statfs and one nvidia-smi call. It only measures and tells: past a limit in Settings (machine.*) its
// coordinator hears once, with the numbers and what uses the machine most, and again only after it came back under.
// What to do about it (pause or queue tasks, clean the disk, tell the human) is the coordinator's call. The same
// numbers decide when Shepherdr starts more tasks (engine.release).
import { readdirSync, readFileSync, readlinkSync, statfsSync, statSync } from 'node:fs'
import { cpus, homedir, tmpdir } from 'node:os'
import type { HealthLevel, HealthMeter } from '../../shared/types.ts'
import type { MachineLimits } from './settings.ts'
import { BOX, helperDir, runSync, type BoxInfo } from './box.ts'
import { join } from 'node:path'

export const SAMPLE_MS = 30_000
/** how long an nvidia-smi read may take before it is killed: a hung GPU read must not become a long event-loop stall */
const SMI_TIMEOUT_MS = 1500
/** the load must stay over its limit this long before the coordinator hears of it: one test run's spike is no news */
export const LOAD_FOR = 120_000
/** herdr must stay silent this long: a restart of it takes a few seconds */
export const HERDR_FOR = 30_000
/** back under: below this share of its limit, so a value hovering at the limit is told once */
export const BACK_UNDER = 0.9

export interface Disk {
  path: string
  /** % full, as df counts it: used over what an ordinary user could have */
  pct: number
  freeGb: number
  dev: number
}

export interface Gpu {
  name: string
  util: number
  memPct: number
}

export interface Sample {
  at: number
  cores: number
  /** 1-minute load average */
  load: number
  /** 5-minute load average: what holds starts back (busy), steadier than the 1-minute one */
  load5?: number
  /** the share of the last minute some task waited for a CPU (%, /proc/pressure/cpu some avg60); none where the kernel
   *  has no pressure stall information */
  cpuSome?: number
  /** the same for memory (%, /proc/pressure/memory some avg60): memory short enough that a task waits for it. Linux only */
  memSome?: number
  /** the same for I/O (%, /proc/pressure/io some avg60). Linux only */
  ioSome?: number
  memTotal: number
  memUsed: number
  /** swap in use, and how much of it there is (bytes, /proc/meminfo): a machine with no swap gives neither, and macOS
   *  gives neither */
  swapUsed?: number
  swapTotal?: number
  disks: Disk[]
  gpus: Gpu[]
}

/** 1-minute load from /proc/loadavg */
export const parseLoad = (text: string) => Number.parseFloat(text.split(/\s+/)[0]) || 0

/** 5-minute load from /proc/loadavg; none when it isn't there */
export const parseLoad5 = (text: string) => {
  const n = Number.parseFloat(text.split(/\s+/)[1] ?? '')
  return Number.isFinite(n) ? n : undefined
}

/** `some avg60` of /proc/pressure/<resource> (cpu, memory, io): the share of the last minute some task waited for it
 *  (%); none without that file (a kernel without PSI, or macOS) */
export const parsePressure = (text: string) => {
  const m = /^some\b.*\bavg60=([\d.]+)/m.exec(text)
  return m ? Number(m[1]) : undefined
}

/** total and in-use memory, and swap in use out of its total (bytes), from /proc/meminfo: in use is what is not
 *  available, swap in use what is not free */
export function parseMem(text: string) {
  const kb = (name: string) => Number(text.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'))?.[1] ?? 0) * 1024
  const total = kb('MemTotal')
  const avail = kb('MemAvailable') || kb('MemFree')
  const swapTotal = kb('SwapTotal')
  return { total, used: Math.max(0, total - avail), swapTotal, swapUsed: Math.max(0, swapTotal - kb('SwapFree')) }
}

/** nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits */
export function parseGpus(text: string): Gpu[] {
  return text
    .split('\n')
    .map((l) => l.split(',').map((x) => x.trim()))
    .filter((f) => f.length >= 4 && f[0])
    .map(([name, util, used, total]) => ({ name, util: Number(util) || 0, memPct: Number(total) ? Math.round((Number(used) / Number(total)) * 100) : 0 }))
}

/** how full a folder's disk is, as df says it */
export function diskOf(path: string): Disk | null {
  try {
    const s = statfsSync(path)
    const used = s.blocks - s.bfree
    const pct = used + s.bavail ? Math.round((used / (used + s.bavail)) * 100) : 0
    return { path, pct, freeGb: (s.bavail * s.bsize) / 2 ** 30, dev: statSync(path).dev }
  } catch {
    return null
  }
}

let smi: string | null | undefined
/** look nvidia-smi up once and remember a miss too: `smi ??=` would look it up again on every sample where it is absent */
function smiPath(): string | null {
  if (smi === undefined) smi = Bun.which('nvidia-smi') ?? null
  return smi
}

/**
 * Read the GPU off the event loop: spawnSync here stalls herdr and the screens for as long as the driver takes (seconds
 * under a compute job). `null` is a read that missed (it timed out or failed) — the caller keeps its last reading;
 * an empty array is a machine with no nvidia-smi at all. `bin` lets a test point at a fake smi.
 */
export async function gpusAsync(bin = smiPath()): Promise<Gpu[] | null> {
  if (!bin) return []
  let proc: ReturnType<typeof Bun.spawn> | undefined
  let expired: (miss: null) => void = () => undefined
  const deadline = new Promise<null>((resolve) => {
    expired = resolve
  })
  const timer = setTimeout(() => {
    if (proc && proc.exitCode === null) proc.kill('SIGKILL')
    expired(null) // a driver stuck in an uninterruptible wait may not exit: settle the read at the cap all the same
  }, SMI_TIMEOUT_MS)
  try {
    const p = Bun.spawn([bin, '--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
    proc = p
    // wait for the process first: waiting for stdout's EOF instead would hang while a child of a killed smi holds it open
    const code = await Promise.race([p.exited, deadline])
    return code === 0 ? parseGpus(await new Response(p.stdout).text()) : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** another machine now, as the helper's health.pl reads it there (box.ts). Exported so a test can check that a sample
 *  from a helper that predates the pressure and swap fields still passes through with those fields undefined. */
export function boxSample(b: BoxInfo): Sample {
  const r = runSync(['perl', join(helperDir(b.home), 'health.pl')], { timeoutMs: 15_000 })
  const j = r.code === 0 ? (JSON.parse(r.out.toString()) as Omit<Sample, 'at'>) : null
  if (!j) return { at: Date.now(), cores: 1, load: 0, memTotal: 0, memUsed: 0, disks: [], gpus: [] }
  return { ...j, at: Date.now(), disks: j.disks.map((d) => ({ ...d, path: d.path === b.home ? homedir() : d.path, dev: Number(d.dev) || 0 })) }
}

/** this machine now: home and /tmp once each (one disk when they are the same); the GPU is read separately, off the loop */
export function sample(gpus: Gpu[] = []): Sample {
  if (BOX) return boxSample(BOX)
  const read = (f: string) => {
    try {
      return readFileSync(f, 'utf8')
    } catch {
      return ''
    }
  }
  const mem = parseMem(read('/proc/meminfo'))
  const disks: Disk[] = []
  for (const p of [homedir(), tmpdir()]) {
    const d = diskOf(p)
    if (d && !disks.some((x) => x.dev === d.dev)) disks.push(d)
  }
  const avg = read('/proc/loadavg')
  const load5 = parseLoad5(avg)
  const cpuSome = parsePressure(read('/proc/pressure/cpu'))
  const memSome = parsePressure(read('/proc/pressure/memory'))
  const ioSome = parsePressure(read('/proc/pressure/io'))
  return {
    at: Date.now(),
    cores: cpus().length || 1,
    load: parseLoad(avg),
    ...(load5 !== undefined ? { load5 } : {}),
    ...(cpuSome !== undefined ? { cpuSome } : {}),
    ...(memSome !== undefined ? { memSome } : {}),
    ...(ioSome !== undefined ? { ioSome } : {}),
    memTotal: mem.total,
    memUsed: mem.used,
    ...(mem.swapTotal ? { swapTotal: mem.swapTotal, swapUsed: mem.swapUsed } : {}),
    disks,
    gpus,
  }
}

export const cpuPct = (s: Sample) => Math.round((s.load / s.cores) * 100)
export const memPct = (s: Sample) => (s.memTotal ? Math.round((s.memUsed / s.memTotal) * 100) : 0)
/** the share of swap in use (%): 0 where the machine has no swap, or gives no swap numbers (macOS) */
export const swapPct = (s: Sample) => (s.swapTotal ? Math.round(((s.swapUsed ?? 0) / s.swapTotal) * 100) : 0)
const gb = (b: number) => `${Math.round(b / 2 ** 30)} GB`
const tilde = (p: string) => (p === homedir() ? 'home' : p)

/* ---------- limits ---------- */

/** new tasks wait: the 5-minute load (the 1-minute one where a machine gives no other), CPU pressure, memory in use
 *  or in swap, memory pressure or I/O pressure is over its start limit (nothing when the limit is by number only) */
export function busy(s: Sample | undefined, l: MachineLimits): 'cpu' | 'memory' | 'io' | undefined {
  if (!s) return undefined
  if (cpuOver(s, l)) return 'cpu'
  if (memoryOver(s, l)) return 'memory'
  if (ioPressureOver(s, l)) return 'io'
  return undefined
}

/** the CPU is past a start limit: its 5-minute load against the cores, or its pressure */
const cpuOver = (s: Sample, l: MachineLimits) =>
  (l.startLoad !== null && (s.load5 ?? s.load) > l.startLoad * s.cores) || (l.startPressure !== null && s.cpuSome !== undefined && s.cpuSome > l.startPressure)

const swapOver = (s: Sample, l: MachineLimits) => l.startSwap !== null && swapPct(s) > l.startSwap
const memPressureOver = (s: Sample, l: MachineLimits) => l.startMemoryPressure !== null && s.memSome !== undefined && s.memSome > l.startMemoryPressure
const ioPressureOver = (s: Sample, l: MachineLimits) => l.startIoPressure !== null && s.ioSome !== undefined && s.ioSome > l.startIoPressure

/** memory is past a start limit: in use, in swap, or the share of the last minute some task waited for it */
export const memoryOver = (s: Sample, l: MachineLimits) => (l.startMemory !== null && memPct(s) > l.startMemory) || swapOver(s, l) || memPressureOver(s, l)

/** the machine short of memory or I/O, in words: each measure over its own start limit now ("swap 45% used (limit
 *  20%)"): what holds starts and what its coordinator is told, so the one news says which */
export function shortage(s: Sample, l: MachineLimits): string[] {
  return [
    ...(swapOver(s, l) ? [`swap ${swapPct(s)}% used (limit ${l.startSwap}%)`] : []),
    ...(memPressureOver(s, l) ? [`memory pressure ${Math.round(s.memSome ?? 0)}% (limit ${l.startMemoryPressure}%)`] : []),
    ...(ioPressureOver(s, l) ? [`I/O pressure ${Math.round(s.ioSome ?? 0)}% (limit ${l.startIoPressure}%)`] : []),
  ]
}

/** swap and the memory and I/O pressure are one alert kind ('pressure'): a machine short of memory or I/O is one state,
 *  so its coordinator hears of it once and again once every one of those limits is under */
export type Kind = 'cpu' | 'memory' | 'pressure' | 'disk' | 'herdr'

/** what is past its alert limit now (over), and what is well back under it (back) */
export function levels(s: Sample, herdr: boolean, l: MachineLimits): Record<Kind, { over: boolean; back: boolean }> {
  const disk = Math.max(0, ...s.disks.map((d) => d.pct))
  const vs = (v: number, limit: number | null) => ({ over: limit !== null && v > limit, back: limit === null || v < limit * BACK_UNDER })
  // the machine's shortness (swap, memory pressure, I/O pressure): over while any of them is, back once every one of
  // the limits set is well under its own
  const set = [
    { v: swapPct(s), limit: l.startSwap },
    { v: s.memSome, limit: l.startMemoryPressure },
    { v: s.ioSome, limit: l.startIoPressure },
  ].filter((x): x is { v: number; limit: number } => x.limit !== null && x.v !== undefined)
  return {
    cpu: vs(s.load, l.alertLoad === null ? null : l.alertLoad * s.cores),
    memory: vs(memPct(s), l.alertMemory),
    pressure: { over: shortage(s, l).length > 0, back: set.every((x) => x.v < x.limit * BACK_UNDER) },
    disk: vs(disk, l.alertDisk),
    herdr: { over: l.alertHerdr && !herdr, back: herdr || !l.alertHerdr },
  }
}

/** one kind's watch: over since when, and whether the coordinator was told */
export interface Watch {
  since?: number
  told?: boolean
}

/**
 * Each kind, from what it was and what it is now: told once when it has been over its limit long enough, and again
 * (that it is back) once it is well under. In between, nothing.
 */
export function judge(was: Partial<Record<Kind, Watch>>, now: Record<Kind, { over: boolean; back: boolean }>, at: number) {
  const hold: Record<Kind, number> = { cpu: LOAD_FOR, memory: 0, pressure: LOAD_FOR, disk: 0, herdr: HERDR_FOR }
  const next: Partial<Record<Kind, Watch>> = {}
  const events: { kind: Kind; what: 'over' | 'back' }[] = []
  for (const kind of Object.keys(now) as Kind[]) {
    const w = { ...was[kind] }
    const { over, back } = now[kind]
    if (w.told) {
      if (back) events.push({ kind, what: 'back' })
      else next[kind] = w
      continue
    }
    if (!over) continue
    w.since ??= at
    if (at - w.since >= hold[kind]) {
      w.told = true
      events.push({ kind, what: 'over' })
    }
    next[kind] = w
  }
  return { next, events }
}

/** each meter for the screen: CPU, Memory, I/O pressure where the kernel gives it, Disk, and each GPU */
export function meters(s: Sample, l: MachineLimits, told: Partial<Record<Kind, Watch>>): HealthMeter[] {
  const level = (over: boolean | undefined, start: boolean): HealthLevel => (over ? 'over' : start ? 'busy' : 'ok')
  const disk = s.disks.reduce<Disk | undefined>((a, d) => (!a || d.pct > a.pct ? d : a), undefined)
  return [
    {
      name: 'CPU',
      pct: cpuPct(s),
      detail: `load ${s.load.toFixed(1)}${s.load5 !== undefined ? ` (5 min ${s.load5.toFixed(1)})` : ''} on ${s.cores} cores${s.cpuSome !== undefined ? ` · pressure ${Math.round(s.cpuSome)}%` : ''}`,
      level: level(told.cpu?.told, cpuOver(s, l)),
    },
    // a held start shows here: memory, swap and memory pressure are the one meter, and the kind told of any of them
    { name: 'Memory', pct: memPct(s), detail: memDetail(s), level: level(told.memory?.told || (told.pressure?.told && (swapOver(s, l) || memPressureOver(s, l))), memoryOver(s, l)) },
    ...(s.ioSome !== undefined
      ? [{ name: 'I/O', pct: Math.round(s.ioSome), detail: 'the share of the last minute some task waited on I/O', level: level(told.pressure?.told && ioPressureOver(s, l), ioPressureOver(s, l)) }]
      : []),
    ...(disk ? [{ name: 'Disk', pct: disk.pct, detail: s.disks.map((d) => `${tilde(d.path)} ${d.pct}%`).join(' · '), level: level(told.disk?.told, false) }] : []),
    ...s.gpus.map((g, i) => ({ name: s.gpus.length > 1 ? `GPU ${i + 1}` : 'GPU', pct: g.util, detail: `${g.name} · memory ${g.memPct}%`, level: 'ok' as const })),
  ]
}

/* ---------- what uses it most ---------- */

export interface Proc {
  pid: number
  /** % of one core over the moment measured */
  cpu: number
  rss: number
  cmd: string
  cwd?: string
}

/** cpu ticks and resident memory of every process, from /proc/<pid>/stat */
function procStats() {
  const out = new Map<number, { ticks: number; rss: number }>()
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const st = readFileSync(`/proc/${name}/stat`, 'utf8')
      const f = st.slice(st.lastIndexOf(')') + 2).split(' ')
      out.set(Number(name), { ticks: Number(f[11]) + Number(f[12]), rss: Number(f[21]) * 4096 })
    } catch {
      /* gone meanwhile */
    }
  }
  return out
}

/** the processes using this machine most over a moment (one second): by CPU, or by memory */
export async function topProcs(by: 'cpu' | 'memory', n = 8, ms = 1000): Promise<Proc[]> {
  // another machine's processes aren't listed: its numbers alone say how it is doing
  if (BOX) return []
  const a = procStats()
  await Bun.sleep(ms)
  const b = procStats()
  const hz = 100
  const all: Proc[] = []
  for (const [pid, x] of b) {
    const cpu = Math.round(((x.ticks - (a.get(pid)?.ticks ?? x.ticks)) / hz / (ms / 1000)) * 100)
    all.push({ pid, cpu, rss: x.rss, cmd: '' })
  }
  const top = all.sort((p, q) => (by === 'cpu' ? q.cpu - p.cpu || q.rss - p.rss : q.rss - p.rss)).slice(0, n)
  for (const p of top) {
    try {
      p.cmd = readFileSync(`/proc/${p.pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ').slice(0, 80)
      p.cwd = readlinkSync(`/proc/${p.pid}/cwd`)
    } catch {
      /* gone meanwhile, or not ours to read */
    }
  }
  return top.filter((p) => p.cmd)
}

/** each task's share: the processes running in its worktree, summed */
export function byTask(procs: Proc[], tasks: { id: string; worktree?: string }[]) {
  const of = (p: Proc) => tasks.find((t) => t.worktree && p.cwd && (p.cwd === t.worktree || p.cwd.startsWith(`${t.worktree}/`)))?.id
  const sums = new Map<string, { cpu: number; rss: number }>()
  for (const p of procs) {
    const id = of(p)
    if (!id) continue
    const s = sums.get(id) ?? { cpu: 0, rss: 0 }
    s.cpu += p.cpu
    s.rss += p.rss
    sums.set(id, s)
  }
  return { of, tasks: [...sums].map(([id, s]) => ({ id, ...s })) }
}

const mb = (b: number) => (b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(1)} GB` : `${Math.round(b / 2 ** 20)} MB`)

/** the lines a coordinator reads: the processes using the machine most, each with its task where it runs in one */
export function procLines(procs: Proc[], tasks: { id: string; worktree?: string }[], by: 'cpu' | 'memory') {
  const t = byTask(procs, tasks)
  const lines = procs.slice(0, 6).map((p) => {
    const id = t.of(p)
    return `  ${by === 'cpu' ? `${p.cpu}% CPU` : mb(p.rss)}  ${p.cmd}${id ? `  (${id})` : ''}`
  })
  const per = t.tasks.sort((a, b) => (by === 'cpu' ? b.cpu - a.cpu : b.rss - a.rss)).map((x) => `${x.id} ${by === 'cpu' ? `${x.cpu}% CPU` : mb(x.rss)}`)
  return [...(per.length ? [`Tasks among them: ${per.join(', ')}.`] : []), 'Using it most now:', ...lines]
}

/** memory in a few words: "19 of 31 GB · swap 4 GB · pressure 24%" (swap and pressure only where the machine gives them) */
const memDetail = (s: Sample) => `${gb(s.memUsed)} of ${gb(s.memTotal)}${s.swapTotal ? ` · swap ${gb(s.swapUsed ?? 0)}` : ''}${s.memSome !== undefined ? ` · pressure ${Math.round(s.memSome)}%` : ''}`

/** the numbers in one line: "CPU 170% (load 27.2 on 16 cores · pressure 31%) · Memory 62% (19 of 31 GB · swap 4 GB) ·
 *  I/O pressure 12% · Disk home 22%": swap and the three pressure readings where the kernel gives them (Linux; a macOS
 *  machine shows none of them) */
export function summary(s: Sample) {
  return [
    `CPU ${cpuPct(s)}% (load ${s.load.toFixed(1)} on ${s.cores} cores${s.cpuSome !== undefined ? ` · pressure ${Math.round(s.cpuSome)}%` : ''})`,
    `Memory ${memPct(s)}% (${memDetail(s)})`,
    ...(s.ioSome !== undefined ? [`I/O pressure ${Math.round(s.ioSome)}%`] : []),
    `Disk ${s.disks.map((d) => `${tilde(d.path)} ${d.pct}% (${Math.round(d.freeGb)} GB free)`).join(', ')}`,
    ...s.gpus.map((g) => `GPU ${g.util}% (${g.name})`),
  ].join(' · ')
}

/* ---------- the watch ---------- */

export interface HealthEvent {
  kind: Kind
  what: 'over' | 'back'
  sample: Sample
  /** herdr: since when it stopped answering */
  since?: number
}

/**
 * Samples this machine every SAMPLE_MS and looks at herdr every few seconds; tells `on` when something crossed its
 * limit or came back under. What was told is kept on disk: a restart (Shepherdr restarts on every merge) tells
 * nothing again while it is still over.
 */
export class Monitor {
  last?: Sample
  /** the last GPU reading, kept when a read misses so the meters still show something */
  private gpus: Gpu[] = []
  /** one GPU read at a time: a tick never waits for it */
  private sampling?: Promise<void>
  /** the async GPU read; a test swaps in a fake or a slow smi */
  readGpus: () => Promise<Gpu[] | null> = gpusAsync
  /** only the plain local sample needs a GPU read of ours: a box sample carries its own machine's GPUs, and a test's take owns its sample */
  private readonly ownSample: boolean
  private take: () => Sample
  private watch: Partial<Record<Kind, Watch>>

  constructor(
    private limits: () => MachineLimits,
    private herdr: () => boolean,
    private on: (e: HealthEvent) => void,
    take?: () => Sample,
    private store: { read: () => Partial<Record<Kind, Watch>>; write: (w: Partial<Record<Kind, Watch>>) => void } = { read: () => ({}), write: () => undefined },
    private onSample: () => void = () => undefined,
  ) {
    this.ownSample = !take
    this.take = take ?? (() => sample(this.gpus))
    this.watch = store.read()
  }

  /** a look: a fresh sample when the last is old (the GPU read starts off the loop, never waited for), then each limit judged */
  tick(now = Date.now()) {
    if (!this.last || now - this.last.at >= SAMPLE_MS - 1000) {
      const fresh = { ...this.take(), at: now }
      this.last = fresh
      if (this.ownSample && !BOX && !this.sampling) this.sampling = this.refresh(fresh).finally(() => (this.sampling = undefined))
    }
    const was = this.watch
    const { next, events } = judge(was, levels(this.last, this.herdr(), this.limits()), now)
    this.watch = next
    if (JSON.stringify(next) !== JSON.stringify(was)) this.store.write(next)
    for (const e of events) this.on({ ...e, sample: this.last, since: was[e.kind]?.since })
  }

  /** read the GPU off the loop and put it in the sample we just took; a miss leaves the last reading in place */
  private async refresh(expected: Sample) {
    const gpus = await this.readGpus()
    if (gpus === null) return
    this.gpus = gpus
    if (this.last === expected) this.last.gpus = gpus
    this.onSample() // the meter has a new number: tell the screen instead of showing it one sample late
  }

  /** what is past its alert limit now, and was told */
  told() {
    return this.watch
  }

  /** over a start limit: new tasks wait */
  busy() {
    return busy(this.last, this.limits())
  }
}
