# Working on Shepherdr

How to run, build and lay out the code: [docs/develop.md](docs/develop.md).

## This fork (rafafortes/shepherdr)

The operator's fork, used on their desktop since 2026-11-04 (herdr installs the plugin from it:
`github:rafafortes/shepherdr@<tag>`). Where this section and the ones below disagree, this one wins.

- **Branches.** `herdr-tui` is our line, the default branch: Shepherdr 2.0, the plugin for the herdr terminal app
  (plugin id `herdr-projects`). `main` mirrors upstream (eliasstravik/shepherdr, now 3.x on herdr-core and the Herdr
  desktop app): never commit to it. Upstream's own 2.0 line is its branch `v2.0`, 42 unreleased commits after v2.0.0;
  41 of them are merged here (#2, up to `bcaa2ca4`), only SHE-295 (the sandboxed coordinator Autopilot) stays out.
- **What we keep.** The herdr terminal app, our own login in front of the web app (a reverse proxy over our VPN, not
  Tailscale), and pi task agents (OpenCode Go and local models) beside Claude Code. An improvement from upstream's 2.1
  or 3.x comes in only when it fits these; port the idea to 2.0's code rather than its herdr-core or Tailscale parts.
- **Upstream is read only.** The `upstream` remote has no push URL. Never open an issue, pull request or comment on
  eliasstravik/shepherdr without the operator's explicit OK; our pull requests go to rafafortes/shepherdr, base
  `herdr-tui`.
- **Upstream intake.** How we watch upstream and what a change must keep (the terminal plugin, our login, pi task
  agents, polylog-bridge's commands) before it comes in: [docs/upstream.md](docs/upstream.md), each improvement since
  v2.0.0 weighed in [docs/upstream-ledger.md](docs/upstream-ledger.md).
- **Releases.** A tag `v2.0.<n>` on `herdr-tui`, only with the operator's yes (as below); `package.json` and
  `herdr-plugin.toml` carry the same version. The desktop moves to it with
  `herdr plugin install rafafortes/shepherdr --ref <tag> --yes`, then the plugin's start action swaps the running
  server.
- **Tests.** The whole check (the types, every test with the browser ones, the build) runs on this machine: GitHub
  Actions is off on this repository since 2026-11-06. `bun run check:local` is what a task runs before `shepherdr
  ready`, and the coordinator runs it on `herdr-tui` before a release (Tests, below).
- Nothing of the operator's host goes into this repository: settings, secrets, hosts and paths stay in
  `~/.shepherdr` and the operator's own tools.

## Language (operator rule, 2026-09-29)

**English for everything except the conversation with the operator.** The agent answers in the language the operator
writes in (Portuguese, with correct accents, or English); everything else is English: code, identifiers, comments,
messages and logs, UI text, docs, config, tests, file and directory names, commit messages, PR and issue text,
reports, journals and memories. Never add Portuguese to a file. Whenever you notice anything that is not in English,
fix it as part of the current work: a gradual correction, a little at a time, never a separate mass translation; old
commits stay as they are. Material whose language is the point stays verbatim (quoted sources, names, test data that
exercises another language on purpose).

## Worktree cleanup (operator rule, 2026-10-05)

An agent removes, without asking, every worktree it created for a task (`git worktree add`, Claude Code's worktree
isolation) once the work is finished (integrated into the target branch or abandoned by decision), plus its build or
gate snapshots, caches and temporary dirs: `git worktree remove <path>`, `git worktree prune`, then delete the task's
branch once its commits are on the target. Before removing, verify nothing unique and wanted remains. Never remove a
worktree, branch or directory another agent or the operator created. This is the operator's standing approval for the
agent's own worktrees and scratch; every other destructive command still needs explicit approval. Like the Language
rule, it is repeated in every `CLAUDE.md` and `AGENTS.md` of the operator's projects.

## Tests

- The whole check runs here: `bun run check:local` (`scripts/check-local.sh`) — `bun run typecheck`, every test with
  the browser tests (`scripts/test.ts`), and the build. It runs last in line for the CPU (nice 19, idle disk), one run
  at a time across every worktree of the repo (a lock file under `$XDG_RUNTIME_DIR` or `~/.cache`, never in the repo and
  never in `~/.shepherdr`), and the test files are capped at `SHEPHERDR_TEST_JOBS` workers (a quarter of the cores by
  default) so herdr, the live server and the agents keep the CPU. It prints one line per step, the failing tests' names
  by file, the verdict and where the logs are. It takes about two minutes warm, longer while other work keeps the
  machine busy or behind another worktree's check (it waits for it, up to an hour): run it with a long timeout, or in
  the background and read the verdict it prints.
- A task runs it before `shepherdr ready` and says the result in `--facts`: passed, about how long, or what failed. The
  coordinator runs it on `herdr-tui` before a release (and that run, there, also refreshes the screen map
  `bun run test changed` picks from). While you work, `bun run typecheck` (seconds) and `bun run test changed` are
  enough to keep moving.
- Check what you changed on the screen by hand in your shared browser, for the proof, against a proof server of your
  own, never the one the human runs: the demo source (`SHEPHERDR_SOURCE=demo`) first, or `HERDR_SOCKET_PATH` at a
  socket that isn't there (as the tests do), a `SHEPHERDR_HOME` under `/tmp`, a `SHEPHERDR_PORT` other than 7787 and
  not another task's, no task that can come due, and stopped by its own pid (keep `$!`, or the pid `server.json` names).
  Never `pkill -f server/main.ts`: that also matches the live server, which runs from `.releases/`.
- A server with a home of its own starts no agent in herdr unless `SHEPHERDR_LAUNCH_AGENTS=1` says it may, and logs
  each one it skips (agents are real CLIs in the herdr it inherits). `test/preload.ts` sets that yes for the tests.
- The tests touch neither `~/.shepherdr` nor the herdr of this machine: `test/preload.ts` gives each file a home of its
  own under `/tmp`, a socket that isn't there and no inherited pane, tab or workspace id. A test that wants a herdr
  brings its own (test/fake-herdr.ts). Run by hand they are the same, and at the lowest priority.
- A browser test skips where its browser can't start, so the run opens both first and names what is missing, and its
  verdict says which parts did not run; a task whose browser was missing says so in `--facts` instead of passing it as a
  whole check. Chromium's headless shell (`bun x playwright-core install --only-shell chromium`, no root) runs every
  browser test, and WebKit, Safari's engine, the iPhone tests (`bun x playwright-core install webkit`); WebKit's system
  libraries come from `sudo bun x playwright-core install-deps webkit`, which only the operator runs.
- Still write tests with your change: the check runs them here. A new browser test goes in the `layout-*.test.ts` file
  of its topic (setup in `test/layout.ts`); split a file that grows past about 20 s.
- GitHub Actions is off: `.github/workflows/check.yml` keeps only `workflow_dispatch`, so nothing waits for GitHub and
  `shepherdr checks` finds nothing to wait for. A branch can still be checked there by hand (`gh workflow run check.yml
  --ref <branch>`, then `gh run watch`), only for a rare case such as a review asking for it.

## Plugins

- `definePlugin` (`src/kernel.ts`, `server/plugin-api.ts`) and the slots of `Registry` (`src/kernel.ts`) are a public
  contract: the human's own plugins in `~/.shepherdr/plugins` rely on them ([docs/plugins.md](docs/plugins.md), Your
  own plugins). Change them with care, keep old names working where you can, update that page's list, and say so in
  your done summary.
- A plugin the human asks you to make for them goes in `~/.shepherdr/plugins/<name>/`, never in the repo.

## Releases

- Never cut a new release (version bump, tag, GitHub release, publish) without asking the human first and getting a
  yes.
- Version bumps are patch only (2.0.0 → 2.0.1) unless the human explicitly asks for a minor or major one.
