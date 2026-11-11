# Merge trains: a proposal and the work started on it

A hand-over for the agent that finishes this. It describes the idea, the design that fits Shepherdr 2.0's code, what is
already written on the branch `feat/merge-train` (a local branch of this repo, one work-in-progress commit on top of
`herdr-tui` at v2.0.40), and what is left. Delete this file once the feature is done; what users need goes into
`docs/tasks.md` and `docs/settings.md`.

## Why

A space with a merge gate (`merge.gate`) merges one task at a time: each merge waits for the gate of the one before it.
With gates of 12 to 18 minutes and five to eight merges waiting, a space lands at most three to six merges an hour, and
the last in line waits more than an hour. The gate checks the tree that would land, so checking several merges stacked
together once lands them all for the time of one run.

The proposal came from the session that tunes the host's performance, relayed at the operator's request: "when several
merges wait, stack the first k branches (each rebased on the one before, in queue order) and run the space's merge gate
once on the top of the stack; on exit 0 land all k in order, each as its own squash commit carrying that gate's line; on
a refusal, bisect (gate the first half) or fall back to one at a time, and tell only the task whose change the failing
half contains; a conflict while stacking drops that task to 'rebasing by hand' and the stack goes on without it. With
k = 3-4 the same gate time lands 3-4 merges."

Upstream (eliasstravik/shepherdr, both `main` and `v2.0`, code, history, issues and pull requests) has nothing for merge
trains or batching; checked 2026-11-11.

## The design

Everything is in `server/live/engine/engine.ts` (the merge path) and `server/live/engine/git.ts`.

- **Setting.** `merge.train` per space (Settings → How tasks work → Merge train): `off` (the default), `2` to `5`, the
  most merges one train takes, the head included. It applies only to the local merge path (`mergeNow` when the space has
  no usable GitHub: the path that runs the merge gate) and only with a merge gate set. A worker machine (`BOX`) never
  builds one.
- **When.** When a task's merge takes its turn (`mergeNow`, after its catch-up, commit and rebase on the base), the
  engine looks for riders: tasks of the same space and base whose merge waits in line now (landing step `queue`, a
  merge in `this.landings`), with the same gate command, their agent not working and no unread message, in line order
  (`landing.at`). None: the merge goes on alone, as today.
- **The stack.** Built with git alone, no checkout touched, the way `G.mergeHere` builds one squash merge: for the head
  and then each rider, `git merge-tree --write-tree <top> <branch>` gives the tree its squash commit would have on top
  of the stack so far, and `git commit-tree` makes that commit. A rider whose tree conflicts with those before it, or
  adds nothing to them, is left out and keeps its place in line (its own turn then rebases it, and a real conflict goes
  to its agent as today). A rider's uncommitted work is committed first (`G.commitAll`), as its own merge would. The
  stack's commits take the base tip's committer date as author and committer date, so the same stack is the same
  commits after a restart.
- **The gate.** Run once, in the head task's worktree, detached at the top of the stack (`git checkout --detach`), then
  the worktree goes back to its branch (`finally`). The head's worktree is used rather than a new one because it has the
  ignored files a worktree needs (`.worktreeinclude`) and warm build outputs: a fresh worktree would fail or rebuild
  from nothing. No task's branch is ever changed by the train. The run is the same detached run as a single merge's
  (`runGate`, extracted from `gate()`), so a restart re-attaches to it (same head, same base tip).
- **Rows.** The head reads "Running the merge gate (a train of 3)" (`landing.cars`); each rider reads "Going in with
  POL-1's merge train" (`landing.train`). Riders hold no slot (they are in `queue`, which `busy()` already skips).
- **On exit 0.** `G.landStack` makes the final commits from the stack's trees, each with its task's words
  (`mergeMessage`: id and title, what its agent said, its facts), the gate's last line and `Merge train: A, B, C (one
  merge gate run)`, and moves the base to the top the way `mergeHere` does: `merge --ff-only` in the base's checkout
  (never over the human's work there) or `update-ref` from the old tip when the base isn't checked out. Either refuses
  when the base moved since the stack was built: nothing changes then. Each task gets its own commit as `squash`, each
  rider `train = <head id>`, and each is marked merged (`markMerged`); main is pushed once when the remote is a GitHub
  gh can't use (`pushBase`, extracted from the single path).
- **The riders' own turns.** A rider's merge is still in the repo's chain behind the head. When its turn comes,
  `mergeNow` sees it merged with `train` set and answers ok with the note "it went in with POL-1's merge train", so its
  caller or its agent (`lateFor` → `tellMerge`) hears that its merge went in.
- **Refused, or anything else.** A refusal, a gate that can't start, or a base that moved: the riders lose their
  `train` mark (back to plain `queue`) and the head goes on alone through the existing single path, which runs its own
  gate. A refusal by the gate also marks every member (`alone`): each goes alone once, on its own gate, before it rides
  or heads a train again, so a change that fails is gated once more, not again in every train.
- **A worktree left detached.** Shepherdr stopping while a train's gate ran leaves the head's worktree detached at the
  top of the stack. `mergeNow` now puts a worktree with no current branch back on the task's branch before anything else.

## What the branch has

One work-in-progress commit on `feat/merge-train` (local, not pushed):

- `server/live/engine/engine.ts`: `Landing.train` and `Landing.cars` with their rows in `landingLine`; `TaskRec.train`;
  `TRAIN_MAX = 5`; `land()` takes extra landing fields; `runGate()` extracted from `gate()` (one run, the detached run
  and its re-attach, the BOX path); `trainSize()`; `train()`; `mergeMessage()` and `pushBase()` extracted from the
  single path; in `mergeNow`, the merged-by-a-train answer, the detached-worktree recovery and the call to `train()`
  before the single gate.
- `server/live/engine/git.ts`: `landStack()`.
- `server/live/settings.ts`: the `merge.train` row, next to `merge.gate`.
- `test/engine-merge.test.ts`: `describe('a merge train')` with two tests: three merges go in on one gate run (rows, one
  run for the train, each its own commit with the gate's line and the train line, the riders' notes, the detached
  recovery); and a rider that conflicts stays out while a refused train goes back to one at a time.

State when it was handed over: `bun run typecheck` passes. The two train tests passed (the first after dropping a last
check on a worktree that had already been put away), and the rest of `test/engine-merge.test.ts`,
`test/cover-source-box.test.ts` and the settings tests passed before the train tests were added. The whole merge file
was not run again after that last edit, and `bun run check:local` was not run at all: start with it.

## What is left

1. **Done.** `bun run check:local` passes with "Coverage held" (phase 2), and every line the train adds to `engine.ts`,
   `git.ts` and `settings.ts` is run by a test; the lines no test runs are older code. `landStack`'s `update-ref` branch,
   its refusal when the base moved, and `train()`'s fall-back when the checkout fails are covered.
2. **Done.** The restart test (`a restart while the train's gate runs`): the head re-attaches to its run, the riders
   resume in line with their mark, and the train lands on the same commits.
3. **Done.** A rider past its deadline is told it "goes in with X's merge train (its gate runs)" when its `train` mark
   is set.
4. **Done.** Refusals no longer repeat. A refused train marks each member, the head included, with `alone` (persisted on
   the task). A marked task rides no train and heads none until its own single gate has ended (merged, refused or
   stopped); then the mark is cleared, and a restart that cuts such a turn short clears it too. Only the task whose
   change fails is told of its refusal; the riders go back to plain queue. Bisect was not built. Tests: a refused train
   of three (each member goes alone once, the failing one alone is told, a task rides again after its turn alone) and
   the mark surviving a restart.
5. Docs: `docs/tasks.md` (the merge gate paragraph and the merge queue paragraph) and `docs/settings.md`; the
   coordinator skill (`skill/shepherdr-coordinator/SKILL.md`) needs nothing unless its words about one gate at a time
   become wrong.
6. **Done.** `startGate`'s files are named for the run (the task, its start and a random part), so a stale run never
   writes over a newer run's exit code. A run that is thrown away (a newer one replaces it, or a restart leaves it dead)
   has its files removed (`dropGate`); a run still going is never killed, and its exit file goes once it ends. The
   gates folder keeps none of them (tests cover both paths).
7. Before a release: the operator's yes (AGENTS.md, Releases). Then the setting for the space that asked for it is the
   operator's to turn on (`shepherdr set merge.train 4 --space <name>`).

## Rules that still hold

The gate is never a git hook. A space's checkout may be a live service's folder: nothing in it is reset, stashed or
written over (only `merge --ff-only`, as `mergeHere`). The gate's line goes into each commit, so the history says which
gate let each merge in. Upstream stays read only; record what was taken or turned down in `docs/upstream-ledger.md`.
