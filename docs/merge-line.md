# Changing the merge line

The merge line is the path every task lands through: one merge at a time per repo, the space's merge gate, merge trains
(`merge.train`), the pre-flight (`merge.preflight`) and `shepherdr line hold`. [tasks](tasks.md) says what it does for the
user and [settings](settings.md) what its rows are; this page is for whoever changes it. A mistake here lands a broken
base or stalls every space, so read it before you start and run the tests below before you hand the work over.

## Where the code is

All of it is under `server/live/engine/` unless said.

- `merge.ts`: `MergeRunner`, a repo's line. `merge()` and `enter()` keep one merge at a time in the order asked,
  `preflighting()` is the pre-flight at the door (outside the line), `hold()`, `release()` and `line()` are the hold and
  what `shepherdr line` shows, `mergeNow()` is one turn's work and asks `train()` before `gate()`.
- `engine.ts`: `train()` stacks the cars, runs one gate on the stack and lands it or searches it by halves;
  `preflightTrain()` is the pre-flight on a forming train; `gate()` is a lone merge's gate; `runGate()` and
  `runPreflight()` are one detached run each; `resumeMerges()`, `sweepGates()` and `reattach()` are what a restart finds,
  and `settleFound()`, `foundRun()` and `endFound()` are what the turn that goes on from it does with the gate run it finds
  (`settleFound()` runs from `mergeNow()` before anything writes in the head's worktree).
- `train-bisect.ts`: the pure part of the search by halves (`firstHalf`, `halves`, `rideBlock`, `groupId`).
- `gate-log.ts`: every run's log, the ledger `gates/ledger.jsonl` in Shepherdr's home, pruning (`GateLedger`).
- `line-hold.ts`: `LineHolds`, the reservation, the expiry and the per-repo gate every turn passes first.
- `server/live/cli-commands.ts` (`lineCommand()`) and `server/live/args.ts` (the help, the verb list): `shepherdr line`.
  `shared/line-wait.ts`: how long a line hold may wait (`LINE_HOLD_WAIT_MAX`) and how long the command waits for it
  (`LINE_HOLD_COMMAND_WAIT`), used by the server and `server/cli.ts`; `helper/shepherdr` is Perl and holds the same number.
  `server/app.ts` gives a command `ctx.signal`, which aborts when its caller goes away.
  `server/live/settings.ts`: the rows `merge.gate`, `merge.preflight`, `merge.train`; the train's cap `TRAIN_MAX` (8) is
  in `engine.ts` and its options also in `src/LimitsPage.tsx` and `test/models-matrix.test.ts`.
- A change of behaviour changes `docs/tasks.md`, `docs/settings.md` and the two skills (`skill/shepherdr-agent`,
  `skill/shepherdr-coordinator`) in the same commit.

## What every change keeps, and the tests that hold it

The files are in `test/`.

- **Nothing lands that no gate run passed on exactly the stack that lands, and a run vouches only for a tree its
  worktree held for the whole run.** The base moves only through `G.landStack`, from the commit the run saw and onto the
  trees it gated; a base that moved meanwhile lands nothing (`moved`). A pre-flight never lets anything in. A train's gate
  runs in its head's worktree detached at the stack: nothing may check out, reset, rebase or write there while the run
  goes on (`settleFound()` waits for a run a restart found, untouched, or ends it first), or its exit code vouches for
  another tree than the one that lands. `engine-merge-train-bisect.test.ts` (each ledger line's `head` is the commit its
  run gated), `engine-merge-train-bisect-line.test.ts` ("main moves while a half goes on its gate run"),
  `engine-merge-train.test.ts` ("main moves while the train's gate runs") and `engine-merge-train-resume.test.ts` (a run a
  restart found is taken up only for the stack it gated, and a gate stand-in that fails the moment a car's file is missing
  from its tree runs the whole restart through).
- **A mark is saved before the next gate starts, so a restart finds the same halves.** `bisect` and `alone` are written
  with `saveNow()` before the gate they decide. `engine-merge-train-bisect-line.test.ts` ("the marks are on disk before
  the next gate starts", "a restart between the halves") and `engine-merge-train.test.ts` ("a refused train's marks are
  on disk across a restart").
- **A member rides only with its refused group, in its own state** (suspect, or unproven), until its own gate passed or
  refused it alone. `train-bisect.test.ts` (`rideBlock`) and `engine-merge-train-bisect-line.test.ts` ("the rest of a
  refused train goes in together; tasks outside its group never ride with it").
- **Only the task whose change fails is told**, and nobody is left marked. `bisectRows()` in `train-world.ts`, run by
  `engine-merge-train-bisect.test.ts`, `engine-merge-train-bisect-mid.test.ts` and
  `engine-merge-train-bisect-large.test.ts`, which also assert the gate runs of each case.
- **A pre-flight lets nothing in and holds nobody up.** It is never under the line's one-at-a-time rule, a failure only
  refuses, a train's search makes at most 12 runs a turn, and cars are marked only once the search ended.
  `engine-merge-preflight.test.ts` ("it never holds the line") and the four `engine-merge-train-preflight*.test.ts`.
- **A held line starts no turn, and a hold always ends**: released, expired (also after a restart), or given up when the
  wait for the merge in flight runs out or the command that waits for it goes away, with no hold left behind: a
  reservation never outlives its command. `engine-line-hold.test.ts`, `engine-line-hold-restart.test.ts`,
  `engine-line-hold-pr.test.ts`, `line-hold.test.ts` (the class alone), `line-hold-cli.test.ts` (the command, its `--wait`
  cap), `app-cli-gone.test.ts` (the route's signal) and `cli.test.ts` (both commands close their end when they give up).
- **Every decision is one log line, and every run is one ledger line with its log kept.**
  `engine-merge-train-bisect.test.ts` ("the lines say what each decision was", "every gate run of a search keeps its log
  and has its line"), the hold tests (they read the log) and `gate-log.test.ts` (names, ledger, rotation, pruning).

## Running those tests

Run the files one at a time, by path: `bun test test/engine-merge-train.test.ts` (a plain `bun test` is turned into
`bun run test` here, `test/preload.ts`: the file runs at the lowest priority with a home of its own under `/tmp`, never
touching the machine's Shepherdr or herdr). A bare word matches every path that holds it, so `bun run test
engine-merge-train` runs all the `engine-merge-train*` files together, in parallel. Measured on 2026-11-27, one file at a
time on a machine at a load average of 4 to 11:

| Files | Each takes |
| --- | --- |
| `train-bisect`, `gate-log`, `line-hold`, `line-hold-cli`, `app-cli-gone`, `engine-line-hold-pr`, `engine-line-hold-restart` | under 2 s |
| `engine-line-hold`, `engine-merge-preflight`, `engine-merge-train-preflight` and its `-faults`, `-position` and `-bound` | 10 to 17 s |
| `engine-merge-train-bisect-line`, `-bisect-mid`, `-bisect-large`, `engine-merge-gate` | 17 to 21 s |
| `engine-merge-train-bisect` (25 s), `engine-merge-train-resume` (27 s), `engine-merge-train` (34 s) | the longest |

All of them one after another take about 3.5 minutes. `cli` (37 s, the commands' own timeouts) is one more for a change to a command's wait or to the helper. The engine files run real git and real gate commands: a gate in a
test is a shell loop that waits for a `go-<task>` file and ends by itself, so a test that hangs is a gate waiting for a
file the test never wrote. Build a new test on `test/train-world.ts` (`trainWorld()`: a blocker holds the line while the
members queue; `bisectRows()`; `trainLog()` reads the server's log) and `test/train-preflight-world.ts` (`ledger()`,
`probes()`, `asked()`): a pre-flight is outside the line, so places come in the order the passes do, and a test that needs
a fixed order waits for each `landing.step` to be `queue` before it asks the next. A failure that is not yours is read
as [AGENTS.md](../AGENTS.md), "Tests", says: alone, on the base, and nothing merges on a red run.

## Mistakes this work made or nearly made

- **A start-up sweep that would have killed a pre-flight the same server had started.** `sweepGates()` ends every gate
  process that no task record claims, and a pre-flight has no record (a restart never keeps one: it runs again). Its live
  set is `preRuns`. Rule: a new kind of detached run in the gates folder is either kept in a task record or named in that
  live set. Test: `engine-merge-preflight.test.ts` ("the sweep a start makes for orphans never ends a pre-flight of this
  Shepherdr's own").
- **A head worktree left detached at a stack commit by a restart.** A train's pre-flight probes and its gate run in the
  head's worktree detached at the stack, and the branch is checked out again after; a restart in between left the
  task's worktree detached at a commit that is on no branch. `reattach()` and `mergeNow()` put it back.
  Rule: a step that checks out a stack restores the branch in a `finally` and has a restart test. Tests:
  `engine-merge-train-preflight.test.ts` ("a restart in the middle of a probe ... no worktree detached"),
  `engine-merge-train.test.ts` ("a restart while the train's gate runs").
- **The larger half first made small trains cost more gate runs than before.** A refused train of three with its first
  or second car at fault took 5 gate runs against the old way's 4. Rule: the smaller half goes first (`firstHalf` is
  `max(1, floor(n / 2))`), so a pair or a trio goes on with its head alone, and the gate-run counts are asserted twice:
  the model in `train-bisect.test.ts` (never more than n + 1 for one fault) and the rows of `bisectRows()`. A change to
  the search changes those numbers on purpose, and says what it costs in the commit.
- **A pre-flight command runs the tree's own script.** It runs in the task's worktree on its branch, and at a train's
  formation on the stack, so a command that calls a script with a new option fails on every branch that does not have
  the option yet, and refuses all of them at the door. Rule: a new option in a script a `merge.preflight` command calls
  must be tolerated by trees without it (the command checks that the script has it, and passes through when it does not).
- **A restart threw away a gate run that was still going.** The resumed merge went through `mergeNow()`, which asks
  `train()` first; with merges waiting in line behind it and trains on, a train formed over the run, its stack's top was
  another commit than the run's, and `runGate()` ended the run (377 s lost on 2026-11-26, a `stopped` ledger line followed
  by a new run of the same task). Rule: a turn that goes on from a restart takes up the run it finds before it stacks
  anything (`train()` reads it with `foundRun()`: a lone run's head is the branch's own commit and goes alone on it, a
  train's run, named by `GateRun.members`, is rebuilt from exactly those members and kept only when its stack is the
  run's commit on the run's base), and a run it cannot take up is ended through `endFound()` with a log line that says
  why. Any step added before `runGate()` in a resumed turn leaves the run alone or ends it that way. A run it cannot
  take up because its cars changed is waited for to its end first (its worktree stays the stack's until then), not killed
  on sight: the cars are only known to differ once the stack is built, after the worktree steps. Tests:
  `engine-merge-train-resume.test.ts`, `engine-merge-train.test.ts` ("a restart while the train's gate runs") and
  `engine-merge-train-bisect-line.test.ts` ("a restart between the halves"). What a swap still costs, and that swapping on
  an empty line or under a hold stays the safe way, is in [upstream](upstream.md), "How a release is cut".
- **The branch checked out under a gate that was still reading the stack.** The first take-up of a train's run (the one
  above) left `mergeNow()`'s own steps as they were: its checkout of the head's branch (it puts back a worktree a dead gate
  left detached) ran while the found run, whose worktree is detached at the stack, was still going, so the other cars'
  files vanished and came back under a live gate, and its exit code could let the stack land. The take-up made that
  flip happen more often, since it keeps such runs. Rule: a run vouches only for a tree its worktree held for the whole
  run, so nothing writes in a worktree a gate run is in. `settleFound()` decides before the first write: a train's run is
  taken up only when its worktree is exactly as the run left it (detached at its commit, clean, the base where it gated),
  then it is waited for, untouched; otherwise it is ended first with the reason, and only then does the branch come back.
  The other writers were walked and each is closed: `resumeMerges()`'s `reattach()` runs only for a task with no live run
  (the run is dropped just before it), `freshen()` (the bring-up-to-base of a task going back to work) returns while the
  task has a `landing`, and the pre-flight's probes run in a turn's own worktree before its gate, never beside one. What a
  clean worktree cannot show is a flip back to the very same commit while the server was down. Test: the gate stand-in of
  `engine-merge-train-resume.test.ts` ("a gate that goes on across the restart sees the stack, whole, from first to
  last"), red before, and the worktree-found-elsewhere tests there.
- **A restart test that fabricated a run the server never wrote.** Two train restart tests started their run by hand with
  no `members`: a record only an older Shepherdr leaves (2.0.85 and before kept no task either), so once a run's record is
  what decides, they took the older rules and proved nothing about the current ones. Rule: a restart test writes
  the run's record as the server does (`space`, and `members` for a train's), and a test for the older records deletes
  `task`, `members` and `space` on purpose (`engine-merge-train-resume.test.ts`, the "older Shepherdr" tests). A record
  with a `task` and no `members` that sits at a stack commit exists in no real data: it is waited for like an older
  train's (its worktree is detached) and then ended as a lone run that cannot go on.
- **A line hold whose command gave up left a hold nobody was told about.** `--wait` had no upper bound while the command
  itself gives up after 47 minutes, so a `--wait` past that ended the caller with "no answer" while the reservation lived on
  in the server and later became a hold in effect, ending only at its `--for` expiry. Rule: a reservation never outlives
  the command that waits for it. `--wait` is capped under what the command waits (`shared/line-wait.ts`, one number for
  `server/cli.ts` and the server; the Perl helper's literal is held equal by `cli.test.ts`), and a command that goes away
  for any reason before the hold took effect (its own limit, an interrupt, the connection closing) cancels the
  reservation through `ctx.signal` with a log line. A new long-waiting command that keeps state in the server for its caller
  reads `ctx.signal` the same way: `/api/cli` otherwise lets a command go on after its caller left, on purpose
  (`doctor` repairs the machines after the client is gone).
