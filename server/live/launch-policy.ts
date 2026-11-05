// A server given a Shepherdr home of its own is not the human's Shepherdr: it is a proof, a second instance, a demo run
// from a checkout. Its agents, though, would be real: herdr holds one herdr per machine, the socket this process
// inherits, so the moment a task came due there (queued, scheduled, relaunched) it would open a real CLI in the
// operator's own herdr, on the default agent of that home. So such a server starts no agent unless it is asked to:
// SHEPHERDR_LAUNCH_AGENTS=1 says it was. The real server, whose home is ~/.shepherdr, is not affected, and neither is
// the demo world (it has no agents at all). bun test sets the yes for itself (test/preload.ts); docs/develop.md says
// how a proof server is run.
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { home } from '../store.ts'

/** the home of the Shepherdr the human runs: an agent started from any other home is not theirs to open */
export const REAL_HOME = resolve(homedir(), '.shepherdr')

/** whether this Shepherdr may start agents in herdr: always at the real home, elsewhere only when told to */
export const launchesAgents = () => process.env.SHEPHERDR_LAUNCH_AGENTS === '1' || resolve(home()) === REAL_HOME

/** why one was not started, for the log and for the chat that asked for it */
export const skippedLaunch = (key: string) =>
  `${key} not started: this Shepherdr has a home of its own (${home()}) and would open its agent in the herdr here. Set SHEPHERDR_LAUNCH_AGENTS=1 to let it start agents.`
