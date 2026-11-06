#!/usr/bin/env bash
# The whole check on this machine, for this fork: the types, every test (the browser tests too) and the build.
# GitHub Actions is off on rafafortes/shepherdr (SHE-21), so this is the check every change goes through:
#
#   bun run check:local        # a task runs it before `shepherdr ready`; the coordinator before a release
#
# It runs at the lowest priority (nice 19, idle disk), one run at a time across every worktree of the repo (a lock
# file under $XDG_RUNTIME_DIR, or ~/.cache where that isn't set: never in the repo, never in ~/.shepherdr), and the
# test files are capped at SHEPHERDR_TEST_JOBS workers (a quarter of the cores by default) so herdr, the live server
# and the agents keep the CPU. A browser test skips where its browser can't start: the browsers are opened first, and
# whatever is missing is named with the command that fixes it (a WebKit without its system libraries needs root).
#
# It takes about two minutes warm, longer while other work keeps the machine busy: run it with a long timeout, or in the
# background and read the verdict it left in its own log folder (it prints that folder; the file is verdict.txt):
#   bash scripts/check-local.sh > /dev/null 2>&1 &
#
# SHEPHERDR_TEST_JOBS caps its test workers, SHEPHERDR_CHECK_WAIT how long it waits for another worktree's check (an
# hour), SHEPHERDR_CHECK_STEP_TIMEOUT how long one step may take (half an hour, where `timeout` exists).
#
# The tests are scripts/test.ts (the same as `bun run test`), which isolates them from ~/.shepherdr and from the herdr
# on this machine (test/preload.ts) and, on the default branch, keeps the screen map `bun run test changed` picks from.
# It prints one line per step, the failing tests' names and the verdict, and says its log folder (and writes all of
# that to verdict.txt in it, for a run left in the background). Exit code 0: every step passed (a browser that could not
# start is named in the verdict and its tests skipped, so read it, never just the code); 1: a step failed; 2: it gave
# up waiting for another check.
set -uo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
branch=$(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null)
[ -n "$branch" ] && [ "$branch" != HEAD ] || branch=$(git -C "$root" rev-parse --short HEAD)
# a log folder of this worktree's own: several worktrees' checks never overwrite each other's
logs="$HOME/.cache/shepherdr/check-local/$(basename "$root")"
mkdir -p "$logs"
V="$logs/verdict.txt"
# a run gone by must not answer for this one, while this one waits for the lock
printf 'check:local is running: no verdict yet\n' >"$V"
# one lock for every session (never in the repo, never in ~/.shepherdr): a shell without XDG_RUNTIME_DIR takes it too
mkdir -p "$HOME/.cache/shepherdr"
lock="$HOME/.cache/shepherdr/check-local.lock"
step_timeout=${SHEPHERDR_CHECK_STEP_TIMEOUT:-1800}
wait_timeout=${SHEPHERDR_CHECK_WAIT:-3600}
case $step_timeout in '' | *[!0-9]*) step_timeout=1800 ;; esac
case $wait_timeout in '' | *[!0-9]*) wait_timeout=3600 ;; esac

dur() {
  local s=$1
  if [ "$s" -ge 60 ]; then printf '%dm%02ds' $((s / 60)) $((s % 60)); else printf '%ds' "$s"; fi
}

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

# one run at a time, whichever worktree it was started from
if command -v flock >/dev/null 2>&1; then
  exec 9>>"$lock"
  if ! flock -n 9; then
    holder=$(cat "$lock.pid" 2>/dev/null)
    echo "Another check${holder:+ (pid $holder)} is running: waiting for it, up to $(dur "$wait_timeout")."
    if ! flock -w "$wait_timeout" 9; then
      printf 'GAVE UP: another check%s still ran after %s; nothing ran here.\n' "${holder:+ (pid $holder)}" "$(dur "$wait_timeout")" >>"$V"
      echo "Gave up waiting for it after $(dur "$wait_timeout"): nothing ran. Try again when it is done."
      exit 2
    fi
  fi
  echo $$ >"$lock.pid"
  trap 'rm -f "$lock.pid"' EXIT
else
  echo "flock is missing: running without the one-at-a-time lock."
fi
# this run's own verdict, from its header on (what stood there while it waited was the note above)
: >"$V"
started=$SECONDS

# the tests that make commits need someone to make them, whatever HOME they commit with (the Check workflow set these
# before it was turned off; a test's own repo has no user identity of its own)
export GIT_AUTHOR_NAME=${GIT_AUTHOR_NAME:-CI} GIT_AUTHOR_EMAIL=${GIT_AUTHOR_EMAIL:-ci@localhost}
export GIT_COMMITTER_NAME=${GIT_COMMITTER_NAME:-CI} GIT_COMMITTER_EMAIL=${GIT_COMMITTER_EMAIL:-ci@localhost}

# one test file per worker: a quarter of the cores, unless told (scripts/test.ts has the same default for every run)
cores=$(nproc 2>/dev/null || echo 4)
jobs=${SHEPHERDR_TEST_JOBS:-$((cores / 4))}
case $jobs in '' | *[!0-9]*) jobs=$((cores / 4)) ;; esac
[ "$jobs" -ge 1 ] || jobs=1
export SHEPHERDR_TEST_JOBS="$jobs"

declare -a failed=()
declare -a notes=()
declare -a what=()

# what the step's log adds to its own line, when it says something
step_note() {
  local log="$logs/$1.log" ran
  case $1 in
    tests) grep -oE 'Ran [0-9]+ tests across [0-9]+ files?' "$log" | tail -1 ;;
    build) grep -oE 'built in [0-9.]+m?s' "$log" | tail -1 ;;
    *) true ;;
  esac
}

step() { # <name> <command...>
  local name=$1
  shift
  local t0=$SECONDS code secs note
  local -a cmd
  cmd=("${prio[@]}")
  [ "$have_timeout" = 1 ] && cmd+=(timeout --foreground -k 60 "$step_timeout")
  cmd+=("$@")
  what+=("$name")
  # fd 9 is the lock: the step's own processes must not keep it open after this check is gone; and the subshell becomes
  # the step itself, so a stop reaches the step and it reaches its own children (scripts/test.ts)
  (
    cd "$root" || exit 1
    exec 9>&-
    exec "${cmd[@]}"
  ) >"$logs/$name.log" 2>&1 &
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
  if [ "$code" -eq 0 ]; then
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

show_failure() { # the reasons a step failed
  local name=$1 log="$logs/$1.log" shown=''
  case $name in
    tests)
      shown=$(failing_tests "$log")
      [ -n "$shown" ] && { echo "Failing tests:"; echo "$shown" | sed 's/^/  /'; }
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

# the dependencies first: a fresh worktree has none, neither the types nor a browser can be read without them, and a
# lockfile that moved since the last install (bun install itself is a no-op when they are all there)
total=4
say() { printf '%s\n' "$1" | tee -a "$V"; }
dirty=''
[ -n "$(git -C "$root" status --porcelain 2>/dev/null)" ] && dirty=' and what is not committed'
say "check:local · $branch at $(git -C "$root" rev-parse --short HEAD)$dirty · $jobs test workers · $priority"
step dependencies bun install --frozen-lockfile
if [ ${#failed[@]} -gt 0 ]; then
  say "The dependencies could not be installed: nothing else runs."
  say "$(show_failure dependencies)"
  say "FAILED in $(dur $((SECONDS - started))) · logs: $logs (verdict.txt)"
  exit 1
fi

# the browsers the tests open, named before the run instead of skipping quietly inside it
probe=("${prio[@]}")
[ "$have_timeout" = 1 ] && probe+=(timeout --foreground -k 60 180)
probe+=(bun "$root/scripts/check-browsers.ts")
browsers=$(cd "$root" && exec 9>&- && "${probe[@]}" 2>&1)
printf '%s\n' "$browsers" >"$logs/browsers.log"
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

# the screen map `bun run test changed` picks browser tests from is recorded on the default branch alone: a task's
# branch would record it at its own commit, and a diff from there would pick no browser test at all
base=$(git -C "$root" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)
base=${base#origin/}
[ -n "$base" ] || base=main
map=()
[ "$branch" = "$base" ] && map=(--map)

step types bun run typecheck
# --force: a check never takes an earlier pass at this commit for its own (a browser that skipped then would hide here)
step tests bun "$root/scripts/test.ts" --force ${map[@]+"${map[@]}"}
step build bun run build

# a browser that died during the run skips its tests instead of failing them (test/chromium.ts): say so, as for the ones
# that could not start at all
skipped=$(grep -c '^(skip) ' "$logs/tests.log" 2>/dev/null || true)
[ -n "$skipped" ] && [ "$skipped" -gt 0 ] && notes+=("the tests: $skipped skipped (a browser that could not start, or a tool this host lacks; see tests.log)")

echo
if [ ${#failed[@]} -eq 0 ] && [ ${#notes[@]} -eq 0 ]; then
  say "PASSED in $(dur $((SECONDS - started))) · logs: $logs"
  exit 0
fi
if [ ${#failed[@]} -eq 0 ]; then
  say "PASSED in $(dur $((SECONDS - started))), with parts of it not run:"
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
say "FAILED in $(dur $((SECONDS - started))): ${failed[*]}"
say "Full logs: $logs (verdict.txt)"
exit 1
