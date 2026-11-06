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
# It takes about two minutes warm, longer on the first run of a worktree (the dependencies come first) and while other
# work keeps the machine busy: run it with a long timeout, or in the background and read the verdict it prints, e.g.
#   bash scripts/check-local.sh > /tmp/shepherdr-check.log 2>&1 &
#
# The tests are scripts/test.ts (the same as `bun run test`), which isolates them from ~/.shepherdr and from the herdr
# on this machine (test/preload.ts) and, on the default branch, keeps the screen map `bun run test changed` picks from.
# It prints one line per step, the failing tests' names, the verdict, and where the full logs are. Exit code 0 only when
# every step passed; a browser that could not start is said in the verdict, never quietly passed.
set -uo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
branch=$(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null)
[ -n "$branch" ] && [ "$branch" != HEAD ] || branch=$(git -C "$root" rev-parse --short HEAD)
# a log folder of this worktree's own: several worktrees' checks never overwrite each other's
logs="$HOME/.cache/shepherdr/check-local/$(basename "$root")"
mkdir -p "$logs"
# the lock's folder: this session's runtime dir, else the cache (never the repo, never ~/.shepherdr)
run=${XDG_RUNTIME_DIR:-$HOME/.cache}
[ -d "$run" ] || run="$HOME/.cache"
mkdir -p "$run/shepherdr"
lock="$run/shepherdr/check-local.lock"
step_timeout=${SHEPHERDR_CHECK_STEP_TIMEOUT:-1800}
wait_timeout=${SHEPHERDR_CHECK_WAIT:-3600}

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

# one run at a time, whichever worktree it was started from
if command -v flock >/dev/null 2>&1; then
  exec 9>>"$lock"
  if ! flock -n 9; then
    holder=$(cat "$lock.pid" 2>/dev/null)
    echo "Another check${holder:+ (pid $holder)} is running: waiting for it, up to $(dur "$wait_timeout")."
    if ! flock -w "$wait_timeout" 9; then
      echo "Gave up waiting for it after $(dur "$wait_timeout"): nothing ran. Try again when it is done."
      exit 2
    fi
  fi
  echo $$ >"$lock.pid"
  trap 'rm -f "$lock.pid"' EXIT
else
  echo "flock is missing: running without the one-at-a-time lock."
fi
started=$SECONDS

# the tests that make commits need someone to make them, whatever HOME they commit with (the Check workflow set these
# before it was turned off; a test's own repo has no user identity of its own)
export GIT_AUTHOR_NAME=${GIT_AUTHOR_NAME:-CI} GIT_AUTHOR_EMAIL=${GIT_AUTHOR_EMAIL:-ci@localhost}
export GIT_COMMITTER_NAME=${GIT_COMMITTER_NAME:-CI} GIT_COMMITTER_EMAIL=${GIT_COMMITTER_EMAIL:-ci@localhost}

# one test file per worker: a quarter of the cores, unless told (scripts/test.ts has the same default for every run)
cores=$(nproc 2>/dev/null || echo 4)
jobs=${SHEPHERDR_TEST_JOBS:-$((cores / 4))}
[ "$jobs" -ge 1 ] || jobs=1
export SHEPHERDR_TEST_JOBS="$jobs"

declare -a failed=()
declare -a notes=()
declare -a what=()

# what the step's log adds to its own line, when it says something
step_note() {
  local log="$logs/$1.log" ran
  case $1 in
    tests)
      ran=$(grep -oE 'Ran [0-9]+ tests across [0-9]+ files?' "$log" | tail -1)
      if [ -n "$ran" ]; then printf '%s' "$ran"; elif grep -q 'Not running them again' "$log"; then printf 'already passed at this commit, nothing changed since'; fi
      ;;
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
  [ "$have_timeout" = 1 ] && cmd+=(timeout -k 60 "$step_timeout")
  cmd+=("$@")
  what+=("$name")
  printf '%d/%d %s … ' "${#what[@]}" "$total" "$name"
  # fd 9 is the lock: the step's own processes must not keep it open after this check is gone
  (cd "$root" && exec 9>&- && "${cmd[@]}") >"$logs/$name.log" 2>&1
  code=$?
  secs=$((SECONDS - t0))
  if [ "$code" -eq 0 ]; then
    note=$(step_note "$name")
    printf 'ok (%s)%s\n' "$(dur "$secs")" "${note:+ $note}"
  elif [ "$have_timeout" = 1 ] && [ "$code" -eq 124 ]; then
    printf 'TIMED OUT (%s)\n' "$(dur "$secs")"
    failed+=("$name")
  else
    printf 'FAILED (%s)\n' "$(dur "$secs")"
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

# the dependencies first: a fresh worktree has none, and neither the types nor a browser can be read without them
deps_stale() {
  local stamp="$root/node_modules/.shepherdr-deps"
  [ -d "$root/node_modules/typescript" ] || return 0
  [ -f "$stamp" ] || return 0
  [ "$root/bun.lock" -nt "$stamp" ] || [ "$root/package.json" -nt "$stamp" ]
}

total=3
deps_stale && total=4
echo "check:local · $branch at $(git -C "$root" rev-parse --short HEAD) · $jobs test workers · $priority"
[ "$total" -eq 4 ] && step dependencies bun install --frozen-lockfile

# the browsers the tests open, named before the run instead of skipping quietly inside it
probe=("${prio[@]}")
[ "$have_timeout" = 1 ] && probe+=(timeout 180)
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

if [ "$total" -eq 4 ] && [ ${#failed[@]} -gt 0 ]; then
  echo "The dependencies could not be installed: nothing else runs."
  show_failure dependencies
  echo "FAILED in $(dur $((SECONDS - started)))"
  echo "Full logs: $logs"
  exit 1
fi

step types bun run typecheck
step tests bun "$root/scripts/test.ts" ${map[@]+"${map[@]}"}
step build bun run build

echo
if [ ${#failed[@]} -eq 0 ] && [ ${#notes[@]} -eq 0 ]; then
  echo "PASSED in $(dur $((SECONDS - started)))"
  exit 0
fi
if [ ${#failed[@]} -eq 0 ]; then
  echo "PASSED in $(dur $((SECONDS - started))), with parts of it not run:"
  for n in "${notes[@]}"; do echo "  ! $n"; done
  exit 0
fi
if [ ${#notes[@]} -gt 0 ]; then
  echo "Not usable here, so it skipped:"
  for n in "${notes[@]}"; do echo "  ! $n"; done
  echo
fi
for name in "${failed[@]}"; do show_failure "$name"; done
echo "FAILED in $(dur $((SECONDS - started))): ${failed[*]}"
echo "Full logs: $logs"
exit 1
