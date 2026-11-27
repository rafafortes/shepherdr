// How long `shepherdr line hold` may wait, in one place for the server and both commands (server/cli.ts, and the helper's
// shepherdr, a Perl script that cannot import this: it holds the same number and test/cli.test.ts keeps the two equal). A hold
// that waits for the merge in flight lives in the server as a reservation, so the command that asked for it must never give
// up before the server does: the server's wait is capped under the command's, and a command that goes away anyway cancels
// its reservation (merge.ts hold).

/** the longest `--wait` a line hold may ask for, in ms: a gate's own limit, which is also the wait's default */
export const LINE_HOLD_WAIT_MAX = 45 * 60_000

/** how long the command waits for the answer of a line hold, in ms: the longest wait and a margin for the rest of the answer */
export const LINE_HOLD_COMMAND_WAIT = LINE_HOLD_WAIT_MAX + 2 * 60_000
