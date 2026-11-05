// A server given a Shepherdr home of its own is not the human's Shepherdr: it is a proof, a second instance, a demo run
// from a checkout. Its agents, though, would be real: herdr holds one herdr per machine, the socket this process
// inherits, so the moment a task came due there (queued, scheduled, relaunched) it would open a real CLI in the
// operator's own herdr, on the default agent of that home, and use up the operator's worktree and clock. So such a
// server starts no agent unless it is asked to: SHEPHERDR_LAUNCH_AGENTS=1 says it was. What may start agents anyway:
// the real home (~/.shepherdr, whose server is the human's), and a worker running another machine (SHEPHERDR_BOX),
// whose launches go to that machine's herdr, not to the one here. The demo world has no agents at all. bun test sets the
// yes for itself (test/preload.ts); docs/develop.md says how a proof server is run.
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { home } from '../store.ts'

/** the home of the Shepherdr the human runs: an agent started from any other home is not theirs to open */
export const REAL_HOME = resolve(homedir(), '.shepherdr')

/** the same folder with its links followed, where it is there already: a home may be a symlink to another disk */
const real = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

/** whether this Shepherdr may start agents in herdr: at the real home, as a worker for another machine, or when told to */
export const launchesAgents = () =>
  process.env.SHEPHERDR_LAUNCH_AGENTS === '1' || !!process.env.SHEPHERDR_BOX || real(home()) === real(REAL_HOME)

/** why one was not started, for the log and for the chat or task that asked for it */
export const skippedLaunch = (key: string) =>
  `${key} not started: this Shepherdr has a home of its own (${home()}) and would open its agent in the herdr here. Set SHEPHERDR_LAUNCH_AGENTS=1 to let it start agents.`

/** the refusal, said in the log once, for a place that would start one before the agents do */
export function refusedLaunch(key: string): Error {
  const why = skippedLaunch(key)
  console.error(`shepherdr: ${why}`)
  return new Error(why)
}
