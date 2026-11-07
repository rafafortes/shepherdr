# Develop

```sh
bun install
bun run demo          # the server with fictional data (the prototype's world), on :7787
bun run dev           # the screen with hot reload, on :5173, talking to the server above
bun run typecheck     # types, in seconds: what to run while you work
bun run test changed  # the tests that reach what you changed from the default branch
bun run test          # every test, in parallel, a quarter of the cores as the check does (but no lock)
bun run check:local   # the whole check: types, every test with the browser ones, the build (about 2 minutes)
```

The whole check runs on this machine: GitHub Actions is off on this repo (2026-11-06), so `.github/workflows/check.yml`
keeps only `workflow_dispatch` and starts nothing by itself. A task runs `bun run check:local` before `shepherdr ready`
and says the result in its facts, and the coordinator runs it on `herdr-tui` before a release. It runs at the lowest
priority (nice 19, idle disk), one run at a time across every worktree of the repo (a lock file under
`$XDG_RUNTIME_DIR`, else `~/.cache`), and the test files are capped at `SHEPHERDR_TEST_JOBS` workers (a quarter of the
cores by default) so herdr, the server and the agents keep the CPU: the tests' own `systemd-run` scope, where systemd
runs this user's services, gives them the least CPU and IO weight too. It takes about two minutes warm, and waits
(up to an hour) while another worktree's check runs, so run it with a long timeout or in the background, where its
verdict waits in `~/.cache/shepherdr/check-local/<worktree>/verdict.txt` (with each step's log beside it).
On a machine where herdr runs as a systemd user service, give it (and the server and agents it holds) the CPU first:
`systemctl --user set-property herdr.service CPUWeight=1000`.

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
