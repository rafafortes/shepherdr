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
# The tests are scripts/test.ts (the same as `bun run test`), which isolates them from ~/.shepherdr and from the herdr
# on this machine (test/preload.ts) and keeps the screen map `bun run test changed` picks from. It prints one line per
# step, the failing tests' names, the verdict, and where the full logs are. Exit code 0 only when everything passed.
set -uo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
mkdir -p "$HOME/.cache/shepherdr/check-local"
logs="$HOME/.cache/shepherdr/check-local"
# the lock's folder: this session's runtime dir, else the cache (never the repo, never ~/.shepherdr)
run=${XDG_RUNTIME_DIR:-$HOME/.cache}
[ -d "$run" ] || run="$HOME/.cache"
mkdir -p "$run/shepherdr"
lock="$run/shepherdr/check-local.lock"
step_timeout=${SHEPHERDR_CHECK_STEP_TIMEOUT:-1800}

# last in line for the CPU and the disk, behind herdr and the agents (env is the no-op a missing tool leaves behind)
prio=(env)
command -v nice >/dev/null 2>&1 && prio+=(nice -n 19)
command -v ionice >/dev/null 2>&1 && ionice -c 3 true >/dev/null 2>&1 && prio+=(ionice -c 3)

# one run at a time, whichever worktree it was started from
if command -v flock >/dev/null 2>&1; then
  exec 9>"$lock"
  if ! flock -n 9; then
    echo "Another check is running: waiting for it to finish."
    flock 9
  fi
else
  echo "flock is missing: running without the one-at-a-time lock."
fi
started=$SECONDS

# one test file per worker: a quarter of the cores, unless told
cores=$(nproc 2>/dev/null || echo 4)
jobs=${SHEPHERDR_TEST_JOBS:-$((cores / 4))}
[ "$jobs" -ge 1 ] || jobs=1
export SHEPHERDR_TEST_JOBS="$jobs"

dur() {
  local s=$1
  if [ "$s" -ge 60 ]; then printf '%dm%02ds' $((s / 60)) $((s % 60)); else printf '%ds' "$s"; fi
}

declare -a failed=()
declare -a notes=()
declare -a what=()

# what the step's log adds to its own line, when it says something
step_note() {
  case $1 in
    tests) grep -oE 'Ran [0-9]+ tests across [0-9]+ files?' "$logs/$1.log" | tail -1 ;;
    build) grep -oE 'built in [0-9.]+m?s' "$logs/$1.log" | tail -1 ;;
    *) true ;;
  esac
}

step() { # <name> <command...>
  local name=$1
  shift
  local t0=$SECONDS code secs
  what+=("$name")
  printf '%d/%d %s … ' "${#what[@]}" "$total" "$name"
  (cd "$root" && "${prio[@]}" timeout "$step_timeout" "$@") >"$logs/$name.log" 2>&1
  code=$?
  secs=$((SECONDS - t0))
  if [ "$code" -eq 0 ]; then
    printf 'ok (%s) %s\n' "$(dur "$secs")" "$(step_note "$name")"
  elif [ "$code" -eq 124 ]; then
    printf 'TIMED OUT (%s)\n' "$(dur "$secs")"
    failed+=("$name")
  else
    printf 'FAILED (%s)\n' "$(dur "$secs")"
    failed+=("$name")
  fi
}

# what a failing step shows: the failing tests by file, the types' errors, or the end of the log when it named nothing
failing_tests() {
  awk '
    /^[[:space:]]*[^[:space:]]+\.test\.tsx?:[[:space:]]*$/ { file = $1; sub(/:$/, "", file); next }
    /\(fail\) / {
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

total=3
[ -d "$root/node_modules/typescript" ] || total=4
echo "check:local · $(git -C "$root" rev-parse --abbrev-ref HEAD) at $(git -C "$root" rev-parse --short HEAD) · $jobs test workers · nice 19, idle disk"

# the dependencies first: a fresh worktree has none, and neither the types nor a browser can be read without them
[ "$total" -eq 4 ] && step dependencies bun install --frozen-lockfile

# the browsers the tests open, named before the run instead of skipping quietly inside it
browsers=$("${prio[@]}" timeout 180 bun "$root/scripts/check-browsers.ts" 2>&1)
for engine in chromium webkit; do
  said=$(printf '%s\n' "$browsers" | sed -n "s/^$engine: //p" | tail -1)
  case $said in
    ok*) true ;;
    '') notes+=("$engine: could not be checked (its probe printed nothing)") ;;
    *) notes+=("$engine: $said") ;;
  esac
done

step types bun run typecheck
step tests bun "$root/scripts/test.ts" --map
step build bun run build

echo
if [ ${#notes[@]} -gt 0 ]; then
  echo "Not usable here, so its tests skip:"
  for n in "${notes[@]}"; do echo "  ! $n"; done
  echo
fi
if [ ${#failed[@]} -eq 0 ]; then
  echo "PASSED in $(dur $((SECONDS - started)))"
  exit 0
fi
for name in "${failed[@]}"; do show_failure "$name"; done
echo "FAILED in $(dur $((SECONDS - started))): ${failed[*]}"
echo "Full logs: $logs"
exit 1
