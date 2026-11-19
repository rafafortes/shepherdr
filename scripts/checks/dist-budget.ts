// What the build put in dist/, and the ratchet that keeps it from growing by accretion: `bun run check:local`'s
// dist-budget step, which runs after the build and only reads the files it made.
//
//   bun scripts/checks/dist-budget.ts [dir]            say what is in <dir> (dist/ by default) and hold it against the
//                                                     baseline: total JS may grow by 1% or 5 KB (whichever is larger),
//                                                     and a new asset over 300 KB fails outright
//   bun scripts/checks/dist-budget.ts [dir] --record   the same, then keep it as the baseline (the check on the default
//                                                     branch, like scripts/coverage.ts)
//
// Vite gives its assets content hashes (index-5tkGkQ0q.js); a rebuild changes them even when nothing really changed, so
// the files are counted under hash-stripped names. The baseline is the default branch's, in the repo's own .git next to
// the coverage baseline, recorded by the check there from a clean tree. Until the first such run there is none, and
// nothing is compared. What already shipped over the cap at the baseline (InterVariable's fonts among it) stays exempt
// while the baseline says so: the cap gates new growth, not the build the baseline was recorded from.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const root = join(import.meta.dir, '../..')

/** the kinds of file the build emits; icons include the splash artwork */
export const KINDS = ['js', 'css', 'font', 'icon', 'wasm', 'other'] as const
export type Kind = (typeof KINDS)[number]

/** a single asset: its hash-stripped name, bytes and kind */
export type Asset = { name: string; bytes: number; kind: Kind }

/** one reading of dist/, in bytes; `files` is keyed by hash-stripped name so a rebuild keeps an asset's identity */
export type Snapshot = {
  total: number
  js: number
  kinds: Record<Kind, number>
  files: Record<string, number>
  top: Asset[]
  exempt: string[]
}

/** what the baseline keeps: the whole snapshot, plus the commit that recorded it */
export type Baseline = { commit: string; at: number } & Snapshot

/** one asset may not arrive over this, unless the baseline already let it (the fonts) */
export const HARD_CAP = 300 * 1024

/** bytes in words, for the human's note and the failures */
export const fmt = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(2)} MB`

/** which kind of asset a name is, by its extension */
export function kindOf(name: string): Kind {
  if (/\.m?js$/.test(name)) return 'js'
  if (name.endsWith('.css')) return 'css'
  if (/\.(woff2?|ttf|otf|eot)$/.test(name)) return 'font'
  if (name.endsWith('.wasm')) return 'wasm'
  if (/\.(svg|ico|png|jpe?g|webp|gif|avif)$/.test(name)) return 'icon'
  return 'other'
}

/** a vite content hash on the end of a name: index-5tkGkQ0q.js -> index.js, so a rebuild is the same asset */
export function normalize(name: string): string {
  const base = basename(name)
  const hash = base.match(/^(.*)-([A-Za-z0-9_-]{8})(\.[^.]+)$/)
  const plain = hash ? `${hash[1]}${hash[3]}` : base
  return name === base ? plain : `${name.slice(0, -base.length)}${plain}`
}

/** all the files under a dist/, or null where there is none; milliseconds: it only stats them */
export function scan(dir: string): Snapshot | null {
  if (!existsSync(dir)) return null
  const files: Record<string, number> = {}
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) {
        const name = normalize(path.slice(dir.length + 1).replace(/\\/g, '/'))
        files[name] = (files[name] ?? 0) + statSync(path).size
      }
    }
  }
  walk(dir)
  const kinds = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<Kind, number>
  const assets: Asset[] = []
  for (const [name, bytes] of Object.entries(files)) {
    const kind = kindOf(name)
    kinds[kind] += bytes
    assets.push({ name, bytes, kind })
  }
  const total = Object.values(files).reduce((a, b) => a + b, 0)
  return {
    total,
    js: kinds.js,
    kinds,
    files,
    top: assets.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name)).slice(0, 10),
    // what already shipped over the cap is grandfathered here (the InterVariable fonts among it); anything else that
    // arrives over the cap fails, so a new big font is not let in until the coordinator records a new baseline
    exempt: assets.filter((a) => a.bytes > HARD_CAP).map((a) => a.name),
  }
}

/** total JS may grow by 1% of the baseline or 5 KB, whichever is larger */
export const slack = (js: number) => Math.max(Math.ceil(js * 0.01), 5 * 1024)

/** what grew past the baseline, one line per breach; none: it held */
export function compare(now: Snapshot, base: Baseline): string[] {
  const fell: string[] = []
  const allowed = slack(base.js)
  if (now.js > base.js + allowed)
    fell.push(`total JS: ${fmt(now.js)} (${now.js} bytes) now, ${fmt(base.js)} (${base.js}) at the baseline + ${fmt(allowed)} allowed: +${now.js - base.js} bytes`)
  const exempt = base.exempt ?? []
  for (const [name, bytes] of Object.entries(now.files))
    if (bytes > HARD_CAP && !exempt.includes(name))
      fell.push(`${name in base.files ? 'asset' : 'new asset'} over the ${fmt(HARD_CAP)} cap: ${name} (${fmt(bytes)}, ${bytes} bytes)`)
  return fell
}

/** the one line a check's note carries: what is in dist/ */
export const summary = (now: Snapshot) => {
  const n = Object.keys(now.files).length
  return `Dist budget: ${fmt(now.js)} JS of ${fmt(now.total)} total, ${n} asset${n === 1 ? '' : 's'}`
}

/** the assets worth reading, largest first: "name  size  kind", ten at most */
export function report(now: Snapshot): string {
  return now.top.map((a) => `${a.name.padEnd(40)} ${fmt(a.bytes).padStart(9)}  ${a.kind}`).join('\n')
}

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  return r.success ? r.stdout.toString() : null
}

/** where the baseline is kept: the repo's own .git, shared by all its worktrees, beside coverage.json */
export function baselineFile(repo = root) {
  const common = git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir')?.trim()
  return join(common || join(repo, 'node_modules', '.cache'), 'shepherdr-test', 'dist-budget.json')
}

export function readBaseline(file: string): Baseline | null {
  try {
    const b = JSON.parse(readFileSync(file, 'utf8')) as Baseline
    return b.commit && b.files ? b : null
  } catch {
    return null
  }
}

/** the command: what is in <dir>, said and held against the baseline and, with --record, kept as it; its exit code.
 *  repo and baseline are this repo's and its .git's, unless a test names its own */
export function main(args: string[], o: { repo?: string; baseline?: string; log?: (s: string) => void } = {}): number {
  const repo = o.repo ?? root
  const log = o.log ?? ((x: string) => console.log(x))
  const [dir = join(repo, 'dist'), ...rest] = args
  const now = scan(dir)
  if (!now) {
    log(`No dist in ${dir}: run bun run build first.`)
    return 2
  }
  log(summary(now))
  log(`The ten largest assets:\n${report(now)}`)
  const file = o.baseline ?? baselineFile(repo)
  const base = readBaseline(file)
  let code = 0
  if (!base) log('No dist baseline yet: the check on the default branch records one; then total JS may grow by 1% or 5 KB and a new asset over 300 KB fails.')
  else {
    const fell = compare(now, base)
    if (fell.length) {
      log(`\nDist budget grew since the baseline (${base.commit.slice(0, 7)}): ${fell.length} breach${fell.length === 1 ? '' : 'es'}. Record a new baseline on the default branch if the growth is wanted.`)
      for (const f of fell) log(`  ${f}`)
      code = 1
    } else log(`Dist budget held: total JS within ${fmt(slack(base.js))} of ${base.commit.slice(0, 7)}; no new asset over ${fmt(HARD_CAP)}.`)
  }
  if (rest.includes('--record')) {
    const commit = git(repo, 'rev-parse', 'HEAD')?.trim() ?? ''
    if (git(repo, 'status', '--porcelain')?.trim()) log("No dist baseline recorded: the tree holds what is not committed, and a baseline is a commit's.")
    else {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ commit, at: Date.now(), ...now } satisfies Baseline))
      log(`Dist baseline of ${commit.slice(0, 7)}: recorded in ${file}.`)
    }
  }
  return code
}

// coverage-exempt: the command itself, which test/checks-dist-budget.test.ts runs through main()
if (import.meta.main) process.exit(main(process.argv.slice(2)))
