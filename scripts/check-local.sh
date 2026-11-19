#!/usr/bin/env bash
# The whole check on this machine, for this fork: dependencies, a dependency audit (bun audit + licence allowlist), a
# gitleaks secret scan, shell/Perl lint, doc links and verbs, the version fields, the types, the language scan, every
# test (the browser tests too), the coverage ratchet (scripts/coverage.ts), the build and the dist budget, each in its
# own file under scripts/checks/.
# GitHub Actions is off on rafafortes/shepherdr (SHE-21), so this is the check every change goes through:
#
#   bun run check:local --quick  # a task's pre-ready run: incremental types + changed tests + build, no coverage; marked
#                                # QUICK in a verdict of its own, never a baseline or a full verdict (the full gate still
#                                # runs at the merge, weekly and before a release)
#   bun run check:local        # the full gate: the merge gate, the weekly sweep and the coordinator before a release
#   bun run check:local --reuse  # the merge gate's cheap question: answers at once when this very tree already passed
#                                # the full check in some worktree, and runs the full check when it did not (QG-10)
#
# It runs in two phases, split by the check's number. Everything below 30 is worktree-local (its own node_modules, its
# own files, no browser): dependencies, secrets, scripts, docs, version, types and language run first, without waiting
# for anybody, so a broken type, script, doc, version or language scan fails in seconds instead of after a queue. The
# checks numbered 30 and up (tests, coverage, build) share the machine's browsers and cores with every other worktree,
# so they go one run at a time under the lock (a file under $XDG_RUNTIME_DIR, or ~/.cache where that isn't set: never
# in the repo, never in ~/.shepherdr).
#
# A --quick run takes a lock of its own (check-local-quick.lock), so it never waits behind a full run; while a full run
# holds its lock, a quick run takes a conservative share of the test workers (max(2, cores / 8), not a quarter of the
# cores) so the full run's browser tests do not flake on the contention. An explicit SHEPHERDR_TEST_JOBS is never
# overridden. Everything runs at the lowest priority (nice 19, idle disk), and the test files are capped at
# SHEPHERDR_TEST_JOBS workers (a quarter of the cores by default) so herdr, the live server and the agents keep the
# CPU. A browser test skips where its browser can't start: the browsers are opened first, and whatever is missing is
# named with the command that fixes it (a WebKit without its system libraries needs root).
#
# It takes about two minutes warm, longer while other work keeps the machine busy: run it with a long timeout, or in the
# background and read the verdict it left in its own log folder (it prints that folder; the file is verdict.txt):
#   bash scripts/check-local.sh > /dev/null 2>&1 &
#
# SHEPHERDR_TEST_JOBS caps its test workers, SHEPHERDR_CHECK_WAIT how long it waits for another run's check of its own
# kind (an hour), SHEPHERDR_CHECK_STEP_TIMEOUT how long one step may take (half an hour, where `timeout` exists).
#
# It prints one line per step, the failing tests' names and the verdict, and says its log folder (and writes all of
# that to verdict.txt in it, for a run left in the background). Exit code 0: every step passed (a browser that could not
# start is named in the verdict and its tests skipped, so read it, never just the code); 1: a step failed; 2: it gave
# up waiting for another check.
#
# A check is one executable file in scripts/checks/, named <number>-<name> with the numbers spaced by ten
# (10-dependencies, 12-audit, 15-secrets, 17-scripts, 18-docs, 19-version, 20-types, 21-language, 30-tests,
# 40-coverage, 50-build, 60-dist-budget). The runner discovers them by sorted file name; a .ts file beside them is a
# check's own logic, not a check. Adding a check is adding one file, and the order is reviewed because it is the file
# name; a number below 30 is worktree-local and a number of 30 or more runs in the shared, one-at-a-time phase (a check
# that needs the machine is numbered there). Each check gets its shared context
# in SHEPHERDR_CHECK_* environment variables (never positional arguments), writes its note to SHEPHERDR_CHECK_NOTE and
# a reason for skipping to SHEPHERDR_CHECK_SKIP, and exits non-zero on failure. The whole contract is in docs/develop.md.
set -uo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
branch=$(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null)
[ -n "$branch" ] && [ "$branch" != HEAD ] || branch=$(git -C "$root" rev-parse --short HEAD)

dur() {
  local s=$1
  if [ "$s" -ge 60 ]; then printf '%dm%02ds' $((s / 60)) $((s % 60)); else printf '%ds' "$s"; fi
}

# --quick (bun run check:local --quick): the pre-ready run, incremental types + changed tests + build. The full gate
# still runs at the merge, weekly and before a release; a quick verdict is never a baseline and never answers where a
# full verdict is asked for (QG-10), so it goes in a file of its own and says what it did not run on its first line.
# --reuse (bun run check:local --reuse): the merge gate's question, answered below before anything runs, by the verdict
# of the tree it ran on. It asks for a full verdict, so a quick run is refused rather than answered.
quick=0
for arg in "$@"; do [ "$arg" = --quick ] && quick=1; done
reuse=0
for arg in "$@"; do [ "$arg" = --reuse ] && reuse=1; done
if [ "$quick" = 1 ] && [ "$reuse" = 1 ]; then
  printf 'check:local: --quick and --reuse ask different things: --reuse is the merge gate question, and only a full check answers it.\n'
  exit 1
fi
# a log folder of this worktree's own: several worktrees' checks never overwrite each other's. A quick run may run
# beside a full run of the same worktree (its own lock, below), so its step logs take a suffix of their own: its verdict
# is already a file of its own (verdict-quick.txt).
logs="$HOME/.cache/shepherdr/check-local/$(basename "$root")"
mkdir -p "$logs"
V="$logs/verdict.txt"
log_suffix=''
if [ "$quick" = 1 ]; then
  V="$logs/verdict-quick.txt"
  log_suffix='-quick'
fi
vname=$(basename "$V")
# every verdict line, not just the header, says a quick run is not a full gate verdict
verdict_kind=''
[ "$quick" = 1 ] && verdict_kind=' (quick run; not a full gate verdict)'
# --reuse: a full PASSED verdict of a clean worktree is kept by the tree it ran on (git's HEAD^{tree}) in one place every
# worktree of the repo shares, and this answers at once when that very tree has one: nothing runs, no test worker is
# taken. A tree is exactly what the check read, so an uncommitted change, a run with a part skipped and a quick run are
# never a tree's verdict; a branch rebased onto a base that moved has another tree, which is checked before it lands.
# a reuse answer goes to whoever runs the check, and into this worktree's verdict once this run has started one of its
# own (a hit before that leaves the verdict.txt of the last run alone)
tell() {
  printf '%s\n' "$1"
  [ -n "${started:-}" ] && printf '%s\n' "$1" >>"$V"
}
verdicts="$HOME/.cache/shepherdr/check-local/verdicts"
tree=''
uncommitted=''
reuse_miss=''
# 0 when it answered (its verdict was printed), 1 when the full check has to run; it reads the tree afresh, since a check
# this one waited behind may have just kept it
reuse_answer() {
  tree=$(git -C "$root" rev-parse --verify --quiet 'HEAD^{tree}' 2>/dev/null)
  uncommitted=$(git -C "$root" status --porcelain 2>/dev/null)
  reuse_miss=''
  [ "$reuse" = 1 ] || return 1
  if [ -z "$tree" ]; then
    reuse_miss='the worktree has no commit yet, so no tree of it can have passed'
  elif [ -n "$uncommitted" ]; then
    reuse_miss='the worktree has uncommitted changes, so no tree of it can have passed'
  elif [ ! -s "$verdicts/$tree" ]; then
    reuse_miss='no full check has passed on this tree yet'
  else
    local at took ago
    at=$(sed -n 's/^at //p' "$verdicts/$tree" | head -1)
    took=$(sed -n 's/^took //p' "$verdicts/$tree" | head -1)
    case $at in '' | *[!0-9]*) reuse_miss='the verdict kept for this tree is unreadable' ;; esac
    [ -z "$reuse_miss" ] || return 1
    case $took in '' | *[!0-9]*) took=0 ;; esac
    ago=$(($(date +%s) - at))
    [ "$ago" -ge 0 ] || ago=0
    tell "check:local reuse · $branch at $(git -C "$root" rev-parse --short HEAD 2>/dev/null) · this exact tree passed the full check already"
    tell "Reused the verdict of $(dur "$ago") ago (it took $(dur "$took")): nothing ran now."
    return 0
  fi
  return 1
}
reuse_answer && exit 0
# a run gone by must not answer for this one, while this one waits for the lock
printf 'check:local is running: no verdict yet\n' >"$V"
# one lock for the full runs of every session (never in the repo, never in ~/.shepherdr): a shell without
# XDG_RUNTIME_DIR takes it too. A --quick run has a lock of its own, so it never waits behind a full run.
mkdir -p "$HOME/.cache/shepherdr"
full_lock="$HOME/.cache/shepherdr/check-local.lock"
quick_lock="$HOME/.cache/shepherdr/check-local-quick.lock"
lock=$full_lock
[ "$quick" = 1 ] && lock=$quick_lock
step_timeout=${SHEPHERDR_CHECK_STEP_TIMEOUT:-1800}
wait_timeout=${SHEPHERDR_CHECK_WAIT:-3600}
case $step_timeout in '' | *[!0-9]*) step_timeout=1800 ;; esac
case $wait_timeout in '' | *[!0-9]*) wait_timeout=3600 ;; esac

# last in line for the CPU and the disk, behind herdr and the agents (env is the no-op a missing tool leaves behind)
prio=(env)
priority=''
command -v nice >/dev/null 2>&1 && prio+=(nice -n 19) && priority+="${priority:+, }nice 19"
command -v ionice >/dev/null 2>&1 && ionice -c 3 true >/dev/null 2>&1 && prio+=(ionice -c 3) && priority+="${priority:+, }idle disk"
have_timeout=0
command -v timeout >/dev/null 2>&1 && have_timeout=1
priority=${priority:-normal priority}

# what runs right now, so a stop can take it with it
STEP_PID=''
stopped=''
stop() {
  stopped=1
  [ -n "$STEP_PID" ] && kill -TERM "$STEP_PID" 2>/dev/null
}
trap stop INT TERM

# a full run holding the shared lock right now: a --quick run then takes a conservative share of the workers instead
# of a quarter of the cores, so the full run's browser tests do not flake on the contention. The probe opens fd 8, tries
# it once and closes it at once: it never keeps the lock and never waits for anybody.
full_lock_held() {
  command -v flock >/dev/null 2>&1 || return 1
  (
    exec 8>>"$full_lock" 2>/dev/null || exit 1
    if flock -n 8; then exit 1; fi
    exit 0
  )
}

# this run's own verdict, from its header on (while a full run waits for the lock it already says where it is)
: >"$V"
started=$SECONDS

# the tests that make commits need someone to make them, whatever HOME they commit with (the Check workflow set these
# before it was turned off; a test's own repo has no user identity of its own)
export GIT_AUTHOR_NAME=${GIT_AUTHOR_NAME:-CI} GIT_AUTHOR_EMAIL=${GIT_AUTHOR_EMAIL:-ci@localhost}
export GIT_COMMITTER_NAME=${GIT_COMMITTER_NAME:-CI} GIT_COMMITTER_EMAIL=${GIT_COMMITTER_EMAIL:-ci@localhost}

# one test file per worker: a quarter of the cores, unless told (scripts/test.ts has the same default for every run)
cores=$(nproc 2>/dev/null || echo 4)
case $cores in '' | *[!0-9]*) cores=4 ;; esac
[ "$cores" -ge 1 ] || cores=1
# what the caller asked for, if anything: an explicit SHEPHERDR_TEST_JOBS is never overridden below
caller_jobs=''
case ${SHEPHERDR_TEST_JOBS:-} in
  '' | *[!0-9]*) caller_jobs='' ;;
  *) [ "$SHEPHERDR_TEST_JOBS" -ge 1 ] && caller_jobs=$SHEPHERDR_TEST_JOBS ;;
esac
jobs=${caller_jobs:-$((cores / 4))}
[ "$jobs" -ge 1 ] || jobs=1
export SHEPHERDR_TEST_JOBS="$jobs"

# a --quick run beside a full one: the full run is using the machine's browsers and cores, so the changed tests take
# max(2, cores / 8) workers rather than a quarter of them, unless the caller set SHEPHERDR_TEST_JOBS itself
capped_by_full=0
cap_jobs_beside_full() { # say: say it when this call lowered the cap
  [ "$quick" = 1 ] || return 0
  [ -z "$caller_jobs" ] || return 0
  full_lock_held || return 0
  local share=$((cores / 8))
  [ "$share" -ge 2 ] || share=2
  [ "$share" -lt "$jobs" ] || return 0
  jobs=$share
  capped_by_full=1
  export SHEPHERDR_TEST_JOBS="$jobs"
  [ "${1:-}" = say ] && say "· a full check is running: the changed tests take $jobs workers, not $((cores / 4))"
  return 0
}
cap_jobs_beside_full

# the screen map and the coverage and dist baselines are recorded on the default branch alone: a task's branch would
# record them at its own commit, and a diff from there would pick no browser test or hold coverage and sizes against the
# wrong commit
base=$(git -C "$root" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)
base=${base#origin/}
[ -n "$base" ] || base=main
map_flag=''
record_flag=''
[ "$branch" = "$base" ] && { map_flag=1; record_flag=1; }
# a quick run picks tests from the map but never records one, and never records a coverage baseline
[ "$quick" = 1 ] && { map_flag=''; record_flag=''; }
cover="$logs/coverage"

# discover the checks by sorted file name: a .ts file beside them is a check's own logic, not a check
# (docs/develop.md). A check that landed without its executable bit is still discovered and fails loudly.
checks_dir="$root/scripts/checks"
mapfile -t check_files < <(find "$checks_dir" -maxdepth 1 -type f ! -name '.*' ! -name '*.ts' -printf '%f\n' 2>/dev/null | LC_ALL=C sort)
if [ "$quick" = 1 ]; then
  # the coverage ratchet needs the whole suite: a quick run leaves it to the full gate (and records no baseline)
  kept=()
  for file in "${check_files[@]}"; do
    [ "${file#*-}" = coverage ] || kept+=("$file")
  done
  check_files=("${kept[@]}")
fi
total=${#check_files[@]}

# two phases, split by the check's number: everything below 30 is worktree-local (its own node_modules, its own files,
# no browser), so it runs before the one-at-a-time lock and a broken type, script, doc, version or language scan fails
# in seconds instead of after a queue; 30 and up (tests, coverage, build) share the machine's browsers and cores and run
# under the lock. A check that needs the machine to itself is numbered 30 or more.
shared_from=30
declare -a local_files=()
declare -a shared_files=()
for file in "${check_files[@]}"; do
  number=${file%%-*}
  case $number in
    '' | *[!0-9]*) local_files+=("$file") ;; # a bad name is reported by the phase that runs it
    *) if [ "$number" -ge "$shared_from" ]; then shared_files+=("$file"); else local_files+=("$file"); fi ;;
  esac
done

# the shared context every check gets by environment, never as positional arguments
export SHEPHERDR_CHECK_ROOT="$root"
export SHEPHERDR_CHECK_LOGS="$logs"
export SHEPHERDR_CHECK_COVER="$cover"
export SHEPHERDR_CHECK_MAP="$map_flag"
export SHEPHERDR_CHECK_RECORD="$record_flag"
export SHEPHERDR_CHECK_QUICK="$quick"

declare -a failed=()
declare -a notes=()
declare -a what=()

say() { printf '%s\n' "$1" | tee -a "$V"; }

# the note a check wrote for its own line: tests say how many ran, coverage its percentage, build its time, the dist
# budget its sizes
step_note() {
  cat "$logs/$1$log_suffix.note" 2>/dev/null
}

step() { # <name> <check file>
  local name=$1 file=$2
  local t0=$SECONDS code secs note
  local -a cmd
  cmd=("${prio[@]}")
  [ "$have_timeout" = 1 ] && cmd+=(timeout --foreground -k 60 "$step_timeout")
  cmd+=("$file")
  what+=("$name")
  rm -f "$logs/$name$log_suffix.note" "$logs/$name$log_suffix.skip"
  export SHEPHERDR_CHECK_NAME="$name"
  export SHEPHERDR_CHECK_LOG="$logs/$name$log_suffix.log"
  export SHEPHERDR_CHECK_NOTE="$logs/$name$log_suffix.note"
  export SHEPHERDR_CHECK_SKIP="$logs/$name$log_suffix.skip"
  # fd 9 is the lock: the check's own processes must not keep it open after this check is gone; and the subshell becomes
  # the check itself, so a stop reaches it and it reaches its own children (scripts/test.ts)
  (
    cd "$root" || exit 1
    exec 9>&-
    exec "${cmd[@]}"
  ) >"$logs/$name$log_suffix.log" 2>&1 &
  STEP_PID=$!
  code=0
  wait "$STEP_PID" || code=$?
  STEP_PID=''
  secs=$((SECONDS - t0))
  if [ -n "$stopped" ]; then
    say "${#what[@]}/$total $name STOPPED ($(dur "$secs")): this check was stopped before it finished"
    exit 130
  fi
  local line="${#what[@]}/$total $name"
  if [ "$code" -eq 0 ] && [ -s "$logs/$name$log_suffix.skip" ]; then
    skipped_reason=$(cat "$logs/$name$log_suffix.skip")
    say "$line skipped: $skipped_reason"
    notes+=("$name: $skipped_reason")
  elif [ "$code" -eq 0 ]; then
    note=$(step_note "$name")
    say "$line ok ($(dur "$secs"))${note:+ $note}"
  elif [ "$have_timeout" = 1 ] && [ "$code" -eq 124 ] && [ "$secs" -ge $((step_timeout - 5)) ]; then
    say "$line TIMED OUT ($(dur "$secs"))"
    failed+=("$name")
  elif [ "$have_timeout" = 1 ] && [ "$code" -eq 137 ] && [ "$secs" -ge $((step_timeout - 5)) ]; then
    say "$line TIMED OUT, killed ($(dur "$secs"))"
    failed+=("$name")
  elif [ "$code" -eq 137 ]; then
    say "$line KILLED ($(dur "$secs")): out of memory, or something else stopped it"
    failed+=("$name")
  else
    say "$line FAILED ($(dur "$secs"))"
    failed+=("$name")
  fi
}

# what a failing step shows: the failing tests by file, the types' errors, or the end of the log when it named nothing
failing_tests() {
  # each test file's section names the file and then its own tests; the closing summary names the failures again, with
  # no file around them, so it is left out (and a test that failed shows once)
  awk '
    /^[[:space:]]*[0-9]+ tests? failed:[[:space:]]*$/ { summary = 1 }
    /^[[:space:]]*[^[:space:]]+\.test\.tsx?:[[:space:]]*$/ { file = $1; sub(/:$/, "", file); next }
    !summary && /\(fail\) / {
      name = $0; sub(/^.*\(fail\) /, "", name); sub(/ \[[0-9.]+ms\]$/, "", name)
      print (file == "" ? name : file " > " name)
    }
  ' "$1" | sort -u
}

# what a run does with the verdict of the tree it read: a full PASSED one is kept for --reuse, and a failure takes away
# whatever that tree had (a tree that just failed is no tree a verdict may answer for, whatever it did before). A run
# with a part skipped, a quick run or an uncommitted tree is never kept, and a base that moved gives the branch another
# tree, so the tree that lands is checked before it lands.
record() { # <1 when it passed whole>
  [ "$quick" = 1 ] && return 0
  [ -n "$tree" ] && [ -z "$uncommitted" ] || return 0
  # the tree this run read, not one the branch may have moved to while it ran
  [ "$(git -C "$root" rev-parse --verify --quiet 'HEAD^{tree}' 2>/dev/null)" = "$tree" ] || return 0
  [ -z "$(git -C "$root" status --porcelain 2>/dev/null)" ] || return 0
  if [ "$1" != 1 ]; then
    [ -f "$verdicts/$tree" ] && rm -f "$verdicts/$tree"
    return 0
  fi
  mkdir -p "$verdicts"
  local tmp="$logs/.verdict.$tree.$$"
  printf 'tree %s\ncommit %s\nbranch %s\nat %s\ntook %s\nlogs %s\n' \
    "$tree" "$(git -C "$root" rev-parse --verify --quiet HEAD)" "$branch" "$(date +%s)" "$((SECONDS - started))" "$logs" >"$tmp" &&
    mv -f "$tmp" "$verdicts/$tree"
}

show_failure() { # the reasons a step failed
  local name=$1 log="$logs/$1$log_suffix.log" shown=''
  case $name in
    tests)
      shown=$(failing_tests "$log")
      [ -n "$shown" ] && { echo "Failing tests:"; echo "$shown" | sed 's/^/  /'; }
      # a run that leaves temporary folders in /tmp fails with no failing test to name: say what it left (test/tmp.ts)
      left=$(sed -n '/^This run left [0-9]* temporary folder/,/^$/p' "$log" | head -22)
      [ -n "$left" ] && { echo "Left behind:"; echo "$left" | sed 's/^/  /'; shown=$left; }
      ;;
    coverage)
      shown=$(sed -n '/^Coverage fell since the baseline/,$p' "$log" | head -14)
      [ -n "$shown" ] && echo "$shown"
      ;;
    dist-budget)
      shown=$(sed -n '/^Dist budget grew since the baseline/,$p' "$log" | head -14)
      [ -n "$shown" ] && echo "$shown"
      ;;
    types)
      shown=$(grep -E 'error TS[0-9]+' "$log" | sort -u | head -8)
      [ -n "$shown" ] && { echo "Type errors:"; echo "$shown" | sed 's/^/  /'; }
      ;;
  esac
  if [ -z "$shown" ]; then
    echo "The end of its log:"
    tail -20 "$log" | sed 's/^/  /'
  fi
}

[ "$total" -gt 0 ] || { say "No checks found in $checks_dir: nothing ran."; exit 1; }

# take this run's lock. A full run takes the shared one only before its shared phase (its worktree-local checks need
# nobody else's machine); a quick run takes its own before any check, so two quick runs still go one at a time and
# neither ever waits behind a full run. 2: it gave up waiting for another run of its kind.
lock_taken=0
acquire_lock() { # <nothing|shared>: what a give-up leaves unrun
  [ "$lock_taken" = 1 ] && return 0
  if ! command -v flock >/dev/null 2>&1; then
    say "flock is missing: running without the one-at-a-time lock."
    lock_taken=1
    return 0
  fi
  exec 9>>"$lock"
  if ! flock -n 9; then
    holder=$(cat "$lock.pid" 2>/dev/null)
    say "Another check${holder:+ (pid $holder)} is running: waiting for it, up to $(dur "$wait_timeout")."
    if ! flock -w "$wait_timeout" 9; then
      if [ "${1:-nothing}" = nothing ]; then
        say "GAVE UP: another check${holder:+ (pid $holder)} still ran after $(dur "$wait_timeout"); nothing ran here."
      else
        say "GAVE UP: another check${holder:+ (pid $holder)} still ran after $(dur "$wait_timeout"); the tests, coverage, build and dist budget did not run."
      fi
      return 2
    fi
  fi
  lock_taken=1
  echo $$ >"$lock.pid"
  trap 'rm -f "$lock.pid"' EXIT
  return 0
}

lock_code=0
dirty=''
[ -n "$(git -C "$root" status --porcelain 2>/dev/null)" ] && dirty=' and what is not committed'
head_commit=$(git -C "$root" rev-parse --short HEAD)
if [ "$quick" = 1 ]; then
  beside=''
  [ "$capped_by_full" = 1 ] && beside=" · $jobs test workers (a full check holds the machine)"
  say "check:local QUICK · $branch at $head_commit$dirty$beside · NOT run: coverage, screen map and baseline · the full suite only if a shared file changed · the full gate runs at the merge, weekly and before a release"
  # its own lock, before any check: two quick runs go one at a time, and neither waits behind a full run
  acquire_lock nothing || lock_code=$?
  [ "$lock_code" -eq 2 ] && exit 2
else
  say "check:local · $branch at $head_commit$dirty${reuse_miss:+ · $reuse_miss} · $jobs test workers · $priority"
fi

# the browsers the tests open, named before the run instead of skipping quietly inside it. The first check installs the
# dependencies playwright-core needs, so the probe runs once right after it; a fake browser is an empty test stand-in
probe=("${prio[@]}")
[ "$have_timeout" = 1 ] && probe+=(timeout --foreground -k 60 180)
probe+=(bun "$root/scripts/check-browsers.ts")
probed=0
ran_tests=0

# one phase's checks, in file-name order: a check gets its line and its log, and the browser probe runs once, right
# after the first check of the run (the first check installs the dependencies playwright-core needs). A failure stops
# the run there; a later phase must not read a half-finished world.
run_phase() {
  local file name said engine what_skips browsers
  for file in "$@"; do
    name=${file#*-}
    if [ "$name" = "$file" ] || [ -z "$name" ]; then
      say "Bad check file name (want <number>-<name>): $file"
      failed+=("$file")
      return
    fi
    step "$name" "$checks_dir/$file"
    [ "$name" = tests ] && ran_tests=1
    [ ${#failed[@]} -gt 0 ] && return
    if [ "$probed" = 0 ]; then
      probed=1
      browsers=$(cd "$root" && exec 9>&- && "${probe[@]}" 2>&1)
      printf '%s\n' "$browsers" >"$logs/browsers$log_suffix.log"
      for engine in chromium webkit; do
        said=$(printf '%s\n' "$browsers" | sed -n "s/^$engine: //p" | tail -1)
        what_skips='every browser test'
        [ "$engine" = webkit ] && what_skips='the iPhone tests'
        case $said in
          ok*) true ;;
          '') notes+=("$engine: could not be checked (scripts/check-browsers.ts said nothing) · $what_skips skip") ;;
          *) notes+=("$engine: $said · $what_skips skip") ;;
        esac
      done
    fi
  done
}

run_phase "${local_files[@]}"

# the shared phase waits for the machine: one run at a time across every worktree (a quick run already took its own
# lock above and never waits here). A failure in the worktree-local checks never gets this far: it fails in seconds.
if [ ${#failed[@]} -eq 0 ] && [ ${#shared_files[@]} -gt 0 ]; then
  if [ "$quick" = 0 ]; then
    say "· worktree-local checks done in $(dur $((SECONDS - started))): the shared phase (tests, coverage, build, dist budget) goes one worktree at a time"
  fi
  lock_code=0
  acquire_lock shared || lock_code=$?
  if [ "$lock_code" -eq 2 ]; then
    say "Full logs: $logs ($vname)"
    exit 2
  fi
  # the check this one waited behind may have kept this very tree's verdict while it ran: asked again here, before the
  # shared phase, which is the part a second run would pay for. What this run already did keeps its lines in its own
  # verdict, and the reuse says so there too
  if reuse_answer; then
    say "check:local reuse: this tree passed the full check already, so the shared phase did not run here"
    exit 0
  fi
  # a full run may have started since this one did: the changed tests then take a conservative share of the workers
  cap_jobs_beside_full say
  run_phase "${shared_files[@]}"
fi

# a browser that died during the run skips its tests instead of failing them (test/chromium.ts): say so, as for the ones
# that could not start at all. Only when they ran: a run stopped earlier must not read an older run's tests.log
if [ "$ran_tests" = 1 ]; then
  skipped=$(grep -c '^(skip) ' "$logs/tests$log_suffix.log" 2>/dev/null || true)
  [ -n "$skipped" ] && [ "$skipped" -gt 0 ] && notes+=("the tests: $skipped skipped (a browser that could not start, or a tool this host lacks; see tests$log_suffix.log)")
fi

echo
if [ ${#failed[@]} -eq 0 ] && [ ${#notes[@]} -eq 0 ]; then
  record 1
  # a --reuse run is the merge gate's, and what it says last goes into the merge commit (docs/tasks.md): the log folder
  # of this machine is said first, so no path of it lands in the repository's history
  if [ "$reuse" = 1 ]; then
    say "· logs: $logs"
    say "PASSED in $(dur $((SECONDS - started)))$verdict_kind"
  else
    say "PASSED in $(dur $((SECONDS - started)))$verdict_kind · logs: $logs"
  fi
  exit 0
fi
if [ ${#failed[@]} -eq 0 ]; then
  # --reuse is the merge gate's question: a tree whose check skipped a part did not pass it, so the gate refuses here
  # rather than passing a tree that nothing checked whole (the pre-ready run still exits 0, saying what did not run)
  if [ "$reuse" = 1 ]; then
    say "NOT A FULL VERDICT in $(dur $((SECONDS - started))): this run did not check the tree whole, so the merge gate refuses it:"
    for n in "${notes[@]}"; do say "  ! $n"; done
    say "· logs: $logs ($vname)"
    exit 1
  fi
  say "PASSED in $(dur $((SECONDS - started)))$verdict_kind, with parts of it not run:"
  for n in "${notes[@]}"; do say "  ! $n"; done
  say "· logs: $logs"
  exit 0
fi
if [ ${#notes[@]} -gt 0 ]; then
  say "Not usable here, so it skipped:"
  for n in "${notes[@]}"; do say "  ! $n"; done
  say ""
fi
for name in "${failed[@]}"; do say "$(show_failure "$name")"; done
record 0
say "FAILED in $(dur $((SECONDS - started)))$verdict_kind: ${failed[*]}"
say "Full logs: $logs ($vname)"
exit 1
