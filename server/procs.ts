// The processes of this user, as far as we can see them: a merge gate or a test's child can outlive the run that
// started it, and a folder left in /tmp says nothing about a loop still forking sleep (LEAD-01). Linux gives a command
// line and a working directory for each pid under /proc; where there is no /proc, ps gives the command line alone.
import { readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'

/** one process of this user: its pid, command line and working directory ('' where the platform can't tell us) */
export type Proc = { pid: number; cmd: string; cwd: string }

/** every process of this user, with what it runs and where. A process that went away meanwhile is simply not here. */
export function processes(): Proc[] {
  if (process.platform === 'linux') {
    const me = process.getuid?.() ?? null
    const out: Proc[] = []
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue
      try {
        const status = readFileSync(join('/proc', name, 'status'), 'utf8')
        if (me !== null && !new RegExp(`^Uid:\\s*${me}\\b`, 'm').test(status)) continue
        const cmd = readFileSync(join('/proc', name, 'cmdline'), 'utf8').split('\0').filter(Boolean).join(' ')
        let cwd = ''
        try {
          cwd = readlinkSync(join('/proc', name, 'cwd'))
        } catch {
          /* it went away, or its working directory is not ours to read */
        }
        out.push({ pid: Number(name), cmd, cwd })
      } catch {
        /* it went away between the listing and the read */
      }
    }
    return out
  }
  // coverage-exempt: this host is Linux; the fallback is for a platform without /proc
  const ps = Bun.spawnSync(['ps', '-axo', 'pid=,command='], { stdout: 'pipe', stderr: 'ignore' })
  // coverage-exempt: same
  return ps.stdout.toString().split('\n').flatMap((line) => { const m = line.match(/^\s*(\d+)\s+(.*)$/); return m ? [{ pid: Number(m[1]), cmd: m[2], cwd: '' }] : [] })
}

/** the parent of each process: a gate's `timeout` wrapper leads a process group of its own, so a kill of just the
 *  detached shell's group would leave the command (and its sleep loop) running (LEAD-01) */
function parents(): Map<number, number> {
  const out = new Map<number, number>()
  if (process.platform === 'linux') {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue
      try {
        const stat = readFileSync(join('/proc', name, 'stat'), 'utf8')
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        out.set(Number(name), Number(fields[1]))
      } catch {
        /* it went away between the listing and the read */
      }
    }
    return out
  }
  // coverage-exempt: this host is Linux; the fallback is for a platform without /proc
  const ps = Bun.spawnSync(['ps', '-axo', 'pid=,ppid='], { stdout: 'pipe', stderr: 'ignore' })
  // coverage-exempt: same
  for (const line of ps.stdout.toString().split('\n')) { const m = line.match(/^\s*(\d+)\s+(\d+)/); if (m) out.set(Number(m[1]), Number(m[2])) }
  // coverage-exempt: same
  return out
}

/** stop a process and every process it started, innermost first: the tree is read before any kill, because a child is
 *  reparented to init as soon as its parent goes. Each group it leads is killed with it (the detached shell's own and
 *  the `timeout` wrapper's); a child that leads no group is killed on its own. */
export function killGroup(pid: number) {
  const parent = parents()
  const tree = [pid]
  for (;;) {
    const more = [...parent].filter(([p, pp]) => tree.includes(pp) && !tree.includes(p)).map(([p]) => p)
    if (!more.length) break
    tree.push(...more)
  }
  for (const p of tree.reverse()) {
    try {
      process.kill(-p, 'SIGKILL')
    } catch {
      try {
        process.kill(p, 'SIGKILL')
      } catch {
        /* it ended already */
      }
    }
  }
}
