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

/** stop a process group: a gate (and a test's shell) is detached, so its pid leads a group of its own. A child that is
 *  not a group leader is killed on its own instead, so a sweep never calls a kill it did not make. */
export function killGroup(pid: number) {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* it ended already */
    }
  }
}
