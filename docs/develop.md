# Develop

```sh
bun install
bun run demo          # the server with fictional data (the prototype's world), on :7787
bun run dev           # the screen with hot reload, on :5173, talking to the server above
bun run typecheck     # types, in seconds warm (tsc's incremental cache in node_modules/.cache): what to run while you work
bun run test changed  # the tests that reach what you changed from the default branch
bun run test          # every test, in parallel, a quarter of the cores as the check does (but no lock)
bun run check:local   # the whole check: dependencies, dependency audit, secrets, scripts, docs, version, types, language, every test with the browser ones, the coverage ratchet, the build (about 2 minutes warm on a quiet machine; 5m34s under load); what the merge gate, the weekly sweep and a release run
bun run check:local --quick  # a task's pre-ready run: incremental types + changed tests + build, no coverage (see below)
bun run check:local --reuse  # the merge gate's cheap ask: answers at once when this tree already passed (see below)
```

The whole check runs on this machine: GitHub Actions is off on this repo (2026-11-06), so `.github/workflows/check.yml`
keeps only `workflow_dispatch` and starts nothing by itself. A task runs `bun run check:local --quick` before `shepherdr
ready` and says the result in its facts; the full check is where nothing may be missed — the merge gate, the weekly
sweep, and the coordinator's run on `herdr-tui` before a release. A check that did not pass keeps the task from
`shepherdr ready` and from merging, whatever file the failure is in: the task fixes a small one and says so, otherwise
it stops, says what fails and why the failure is not its own, and its coordinator decides. It runs at
the lowest priority (nice 19, idle disk), one run at a time across every worktree of the repo (a lock file under
`$XDG_RUNTIME_DIR`, else `~/.cache`), and the test files are capped at `SHEPHERDR_TEST_JOBS` workers (a quarter of the
cores by default) so herdr, the server and the agents keep the CPU: the tests' own `systemd-run` scope, where systemd
runs this user's services, gives them the least CPU and IO weight too. It takes about two minutes warm on a quiet
machine, 5m34s under load; it also waits (up to an hour) while another worktree's check runs, so run it with a long
timeout or in the background, where its verdict waits in
`~/.cache/shepherdr/check-local/<worktree>/verdict.txt` (with each step's log beside it).
On a machine where herdr runs as a systemd user service, give it (and the server and agents it holds) the CPU first:
`systemctl --user set-property herdr.service CPUWeight=1000`.

`bun run check:local --quick` is a task's pre-ready run: the same incremental types and build, but `30-tests` runs
`bun run test changed --force` instead of the whole forceful suite, and `40-coverage` does not run at all (so no screen map or
coverage baseline is recorded). Its verdict says `QUICK` and what it did not run on its first line, in
`verdict-quick.txt`, so it can never be taken for a full verdict where one is asked for; a quick run that fails types
or the build still fails the gate. A change to a file that can break any test — `test/preload.ts`, `test/once.ts`,
`scripts/test.ts`, `package.json`, `bun.lock`, `bunfig.toml`, `tsconfig.json` (`scripts/test.ts`'s `EVERYTHING` list) —
runs the whole suite in a quick run as well, so a change to the harness or the config is never proven by a handful of
files. Never hand the runner a worker count of one (`SHEPHERDR_TEST_JOBS=1`) to make a run simpler: it serializes the
suite, and the lock is the only thing that should queue a run (one worker is for debugging a test's order). The full
check is never skipped for a quick one: it runs at the merge gate, weekly on `herdr-tui`, and before every release.
`scripts/build-plugins.ts` hashes its inputs into `node_modules/.cache` so the
typecheck, tests and build steps share one build per run instead of three, and `tsc`'s `--incremental` cache lives
there too. A release symlinks its `node_modules` to a shared deps folder, where the hash and the check that the
registries still match what it wrote keep a shared cache safe; neither weakens what any step checks.

`bun run check:local --reuse` is the question a merge gate asks (`merge.gate`, [tasks](tasks.md)): when this very
tree already passed the full check in any worktree of the repository it prints when and how long, runs nothing, and
exits 0; with no such verdict it runs the full check, saying in its first line why. A full PASSED verdict of a clean
worktree is kept by the tree it ran on (`git rev-parse HEAD^{tree}`) in
`~/.cache/shepherdr/check-local/verdicts/<tree>`, one place every worktree shares, so a tree whose verdict stands is not
checked again; a later full run that fails on the same tree takes that verdict away. A run with a part skipped, a quick
run and an uncommitted worktree are never kept: they did not check that tree whole. Asked as `--reuse`, a run that ends
with a part skipped is refused (exit 1, naming what did not run) rather than pass the gate on it, and an uncommitted
worktree or one with no commit has no tree to name, so its full check runs and keeps nothing; `--quick` and `--reuse`
together are refused. A branch rebased onto a base that moved has a tree no verdict names, so it is checked in full
before it lands: two branches that each passed on the old base cannot break the base together. The gate runs its
command in the task's worktree after the rebase, at the tip that lands, so the tree it asks for is the one that lands,
and a `--reuse` run's last line (the one a merge commit carries) names no path of this machine. Commit the work before
running the check: a run on a worktree with uncommitted changes is kept for no tree, and the commit the merge makes
would leave the gate a tree it has to check in full. A verdict is only as good as the run behind it: the tree is not a
run's only input (the base's history, the host's browsers, the coverage baseline and `node_modules` decide one too), and
since the gate runs the branch's own script, an agent that edits it or writes a verdict file can still fake a pass —
the flag closes the quiet skip, not tampering. A hit leaves the worktree's own `verdict.txt` as the last run left it (a
hit that waited behind another check writes a line saying nothing ran here). A verdict does not expire: it goes away when
a full run of that tree fails, or when the folder is cleared, so clear `~/.cache/shepherdr/check-local/verdicts` after
changing the host's tools (a new browser, another gitleaks) if the trees should be checked again.

The runner (`scripts/check-local.sh`) keeps the lock, the log folder, `verdict.txt` and the browser probe; each step is
one executable file in `scripts/checks/`, named `<number>-<name>` with the numbers spaced by ten (`10-dependencies`,
`12-audit`, `15-secrets`, `17-scripts`, `18-docs`, `19-version`, `20-types`, `21-language`, `30-tests`, `40-coverage`,
`50-build`, `60-dist-budget`). The runner discovers the executable
files by sorted file name, so adding a check is adding one file and no later task edits a shared list: a `.ts` file
beside them is a check's own logic, not a check (e.g. `secrets.ts`), and the order is reviewed because it is the file
name. A check file:

- gets its shared context in `SHEPHERDR_CHECK_*` environment variables, never positional arguments:
  `SHEPHERDR_CHECK_ROOT`, `SHEPHERDR_CHECK_LOGS`, `SHEPHERDR_CHECK_COVER`, `SHEPHERDR_CHECK_MAP` and
  `SHEPHERDR_CHECK_RECORD` (the last two are `1` only on the default branch, for the screen map and the coverage and
  dist baselines, and both empty in a `--quick` run), `SHEPHERDR_CHECK_QUICK` (`1` in a quick run), plus its own
  `SHEPHERDR_CHECK_NAME`, `SHEPHERDR_CHECK_LOG`, `SHEPHERDR_CHECK_NOTE` and `SHEPHERDR_CHECK_SKIP`;
- exits 0 on pass and non-zero on failure (the runner maps 124/137 to timed out or killed, and stops at the first
  failure, so a later check never reads a half-finished world);
- writes its note — the human line appended to its result, e.g. how many tests ran — as one line to
  `$SHEPHERDR_CHECK_NOTE`; its stdout and stderr already go to `$SHEPHERDR_CHECK_LOG` (`<logs>/<name>.log`), the log the
  runner reads to show why a failure happened;
- says it cannot run (a tool is missing, say) by writing one reason to `$SHEPHERDR_CHECK_SKIP` and exiting 0: the result
  line reads `N/<total> <name> skipped: <reason>`, is named in the verdict's "parts not run", and is not a failure.

The secrets step (`15-secrets`, whose logic is `scripts/checks/secrets.ts`) runs `gitleaks detect --source . --redact`,
so it reads the committed tree and its history, not uncommitted files: commit before the gate. Its JSON report goes to
the run's log folder, never the repo, and only a finding's file, line and rule are printed, never its value. A finding
that predates the step is baselined in `.gitleaksignore` as one fingerprint per line, with a `#` line above saying why
it is a false positive or a revoked token; a new fingerprint fails the step. A host without gitleaks skips it with the
install command, and the verdict names the part that did not run.

The audit step (`12-audit`, whose logic is `scripts/checks/audit.ts`) runs `bun audit --json` right after dependencies:
Bun reads `bun.lock` and asks the npm advisory database, with no second binary to pin. Advisory ids that are already
accepted are kept in the repo's `.git` (`shepherdr-audit/accepted.json`, recorded by the check on the default branch as
the coverage baseline is); a new id fails the step with its package, severity, affected range and advisory link, while
an accepted one is only a comment. The same script checks each locked package's installed licence against an allowlist
of permissive licences (including MPL-2.0 and OFL-1.1, which the tree already uses); an unknown licence fails naming
its package, including packages installed under a parent; packages not installed here (other platforms, say) are
counted, not failed. A registry that cannot be reached is a note on a green step and a skip reason in the verdict:
offline work is never blocked by it.

The scripts step (`17-scripts`, whose logic is `scripts/checks/scripts.ts`) runs `shellcheck -S warning` over
`scripts/*.sh`, `bin/shepherdr` and `bin/agent-browser`, and `perl -c` over `helper/*.pl` and `helper/shepherdr`. A
warning or a syntax error fails with its file and line; an accepted finding is baselined with `# shellcheck disable=`
and the reason on the line. perlcritic is not gated on: its style rules are too opinionated for a check. A host without
either tool skips just that part, naming it, and the verdict says what did not run.

The docs step (`18-docs`, whose logic is `scripts/checks/docs.ts`) resolves every relative markdown link in `docs/`,
`README.md`, `AGENTS.md` and `skill/` against the tree — external URLs are never fetched — and checks every
`shepherdr <verb>` instruction there against the commands `shepherdr help` actually lists, so a renamed verb cannot
leave stale orders that task agents obey. A broken link fails with its file and target; a stale verb fails with its
line. The two upstream pages (`docs/upstream.md`, `docs/upstream-ledger.md`) quote another line's command names as
their subject, so they are left out of the verb check.

The version step (`19-version`, whose logic is `scripts/checks/version.ts`) fails when `package.json` and
`herdr-plugin.toml` disagree on `version`, and checks `plugins.json` too if a release gives it one: the bump edits these
by hand in separate places, the moment a forgotten one ships a mismatch that breaks plugin installs.

The language step (`21-language`, whose logic is `scripts/checks/language.ts`) scans the code files the diff from the
default branch touches for prose-like runs of non-ASCII letters and fails with the file and line, so a Portuguese
sentence cannot be committed on a reviewer's notice alone. Em dash, curly quotes, ellipsis and emoji are not letters
and are never flagged; test fixtures, the emoji keyword table and a `language-allow: <why>` marker (for quoted sources
and user-facing strings) are the explicit allowlist. `SHEPHERDR_LANGUAGE_SCOPE=tree` scans the whole tree instead —
that is the weekly run.

The dist-budget step (`60-dist-budget`, whose logic is `scripts/checks/dist-budget.ts`) runs after the build and only
reads the files in `dist/`: total JS may grow by 1% or 5 KB (whichever is larger) since the baseline, and an asset over
300 KB fails outright unless the baseline already carried it over that size. The baseline keeps the sums by kind and the
ten largest assets, with Vite's content hashes stripped from their names so a rebuild of the same asset is not a new
one; the assets that already shipped over the cap, InterVariable's fonts among them, stay exempt because the baseline
says so. It is the default branch's, kept in the repo's `.git` beside `coverage.json` and recorded by the check there
from a clean tree, like the coverage baseline.

The tests never touch the Shepherdr on this machine or its herdr: `test/preload.ts` gives each file a home of its own
under `/tmp`, a socket that isn't there and no inherited pane, tab or workspace id. Every temporary folder a test makes
comes from `test/tmp.ts` (`tmp('name')`, never a plain `mkdtempSync`): it is named after the run and the process that
made it and removed when that file's tests end, failing or not, and a whole run fails if one of its own is left behind.
What a killed run leaves (two hours old, its process gone: `/tmp` sits on the root disk and keeps it for a month) is
swept at the start of the next one. A browser test skips where its
browser can't start, and `bun run check:local` opens both browsers first and names what to install: Chromium's headless
shell for every browser test, and WebKit for the iPhone ones, whose system libraries need root
(`sudo bun x playwright-core install-deps webkit`).

Agents working on Shepherdr: [AGENTS.md](../AGENTS.md) says what they check before merging.

The demo source (`SHEPHERDR_SOURCE=demo`) holds a fictional world for reviewing every screen and case without real
agents. Your data lives in `~/.shepherdr` (`SHEPHERDR_HOME` to move it).

A server with a home of its own (`SHEPHERDR_HOME`) starts no agent in herdr unless `SHEPHERDR_LAUNCH_AGENTS=1` says it
may, and logs each one it skips: its agents would be real CLIs in the herdr it inherits, so a task that came due there
would open one in the human's own herdr. A worker for another machine (`SHEPHERDR_BOX`) starts them there as long as its
main server's home is the real one, or was told to with that variable. A proof uses the demo source, or
`HERDR_SOCKET_PATH` at a socket that isn't there, a home under `/tmp`, a `SHEPHERDR_PORT` other than 7787, no task that
can come due, and stops the server by its own pid (`$!`, or `server.json` in a live home) — never
`pkill -f server/main.ts`, which also matches the live one.

```text
server/            the web server, the demo source and the live source
  live/            herdr link, chats from logs (readers/), tasks (engine/), settings, machines (box, mirror, install), voice, browser
src/               the screen's kernel, layout and shared pieces
plugins/<name>/    each base plugin's parts (yours: ~/.shepherdr/plugins/<name>/)
skill/             what every agent is taught (shepherdr/), coordinators (shepherdr-coordinator/), task agents (shepherdr-agent/)
helper/            what Shepherdr puts on another machine: its shepherdr command, hook recorder, log copier, health, browser relay
bin/shepherdr      the command agents use
bin/agent-browser  agent-browser at the pinned version, for each task's shared browser
```

Task IDs are configured only in Settings → a repository space → Task IDs. The automatic prefix remains the default;
changing it affects new tasks only. Prefixes (1–16 uppercase letters/digits, starting with a letter) are reserved on
the owning machine, including historical prefixes. Other machines may use the same prefix: remote references remain
machine-qualified. Space display renames already preserve the key.

The next number can stay put or move forward, never back. Skipped numbers remain reserved, including after changing
prefix, so a space's worktree/branch numbers also never repeat. `task-ids.sqlite` in the owning machine's Shepherdr
home is the durable reservation ledger; retain it when backing up or moving that home (with its WAL if running).
It imports existing `tasks.json` counters and task history automatically. Reservations commit before task creation;
a failed creation can leave a gap. `spaces.json` mirrors the current prefix; the ledger is authoritative after migration.
