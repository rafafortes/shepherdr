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
  `runPreflight()` are one detached run each; `resumeMerges()`, `sweepGates()` and `reattach()` are what a restart finds.
- `train-bisect.ts`: the pure part of the search by halves (`firstHalf`, `halves`, `rideBlock`, `groupId`).
- `gate-log.ts`: every run's log, the ledger `gates/ledger.jsonl` in Shepherdr's home, pruning (`GateLedger`).
- `line-hold.ts`: `LineHolds`, the reservation, the expiry and the per-repo gate every turn passes first.
- `server/live/cli-commands.ts` (`lineCommand()`) and `server/live/args.ts` (the help, the verb list): `shepherdr line`.
  `server/live/settings.ts`: the rows `merge.gate`, `merge.preflight`, `merge.train`; the train's cap `TRAIN_MAX` (8) is
  in `engine.ts` and its options also in `src/LimitsPage.tsx` and `test/models-matrix.test.ts`.
- A change of behaviour changes `docs/tasks.md`, `docs/settings.md` and the two skills (`skill/shepherdr-agent`,
  `skill/shepherdr-coordinator`) in the same commit.

## What every change keeps, and the tests that hold it

The files are in `test/`.

- **Nothing lands that no gate run passed on exactly the stack that lands.** The base moves only through `G.landStack`,
  from the commit the run saw and onto the trees it gated; a base that moved meanwhile lands nothing (`moved`). A
  pre-flight never lets anything in. `engine-merge-train-bisect.test.ts` (each ledger line's `head` is the commit its run
  gated), `engine-merge-train-bisect-line.test.ts` ("main moves while a half goes on its gate run") and
  `engine-merge-train.test.ts` ("main moves while the train's gate runs").
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
  wait for the merge in flight runs out, with no hold left behind. `engine-line-hold.test.ts`,
  `engine-line-hold-restart.test.ts`, `engine-line-hold-pr.test.ts`, `line-hold.test.ts` (the class alone) and
  `line-hold-cli.test.ts` (the command).
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
| `train-bisect`, `gate-log`, `line-hold`, `line-hold-cli`, `engine-line-hold-pr`, `engine-line-hold-restart` | under 2 s |
| `engine-line-hold`, `engine-merge-preflight`, `engine-merge-train-preflight` and its `-faults`, `-position` and `-bound` | 10 to 17 s |
| `engine-merge-train-bisect-line`, `-bisect-mid`, `-bisect-large`, `engine-merge-gate` | 17 to 21 s |
| `engine-merge-train-bisect` (25 s), `engine-merge-train` (34 s) | the longest |

All of them one after another take about 3.5 minutes. The engine files run real git and real gate commands: a gate in a
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
- **A swap of the running server can end a gate run that is going on**: with merges waiting in line behind it and trains
  on, the resumed merge forms a train first (`mergeNow()` asks `train()` before `gate()`), and `runGate()` ends the old
  run it cannot take up again. [upstream](upstream.md), "How a release is cut", says when to swap.
