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
- **Tests.** The Check workflow runs on every pull request into `herdr-tui` and on every push to it (a merge), so a
  task sees its own run on its pull request; a change that touches only `**/*.md` or `docs/**` skips it, and `main`
  gets no run. On this machine run only `bun run typecheck` (Tests, below).
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

- No tests on this machine: it keeps the CPU for herdr, the server and the agents. While you work and before you
  merge, run only `bun run typecheck` (seconds). Don't run `bun run test`, `bun test`, `bun run test changed`,
  `bun run check` or any browser test here.
- Check what you changed on the screen by hand in your shared browser, for the proof, against a proof server of your
  own, never the one the human runs: the demo source (`SHEPHERDR_SOURCE=demo`) or a fake herdr first, a
  `SHEPHERDR_HOME` under `/tmp`, a loopback port that isn't 7787, no task that can come due, and stopped by its own
  pid. Never `pkill -f server/main.ts`: that also matches the live server, which runs from `.releases/`.
- A server with a home of its own starts no agent in herdr unless `SHEPHERDR_LAUNCH_AGENTS=1` says it may, and logs
  each one it skips (agents are real CLIs in the herdr it inherits). `test/preload.ts` sets that yes for the tests.
- GitHub runs the whole check (types, every test with the browser tests, the build) on every pull request into
  `herdr-tui` and again on every push to it (a merge): the Check workflow (`.github/workflows/check.yml`), which skips
  a pull request and a push that touch only `**/*.md` or `docs/**` (its `paths-ignore`, the skill files included). A
  red `herdr-tui` reaches the coordinator, who has it fixed forward. A failure's log is
  `gh run view <run> --log-failed`.
- It spends the operator's Actions minutes: 8 to 15 billed per run once the caches are warm, each job rounded up to
  its minute (1 for the types and the build, 2 to 7 per test shard); a run with cold caches costs more, as a shard then
  installs the browser's system libraries from apt (7 to 15 minutes in one of 2026-11-05's runs). A task whose pull
  request merges spends two, its own and the merge's; every push to a pull request runs it all again. A task on "merge
  on its own" does not wait for its run: to see it first, `shepherdr checks <id>` waits for it (up to about 9 minutes).
- A branch with no pull request can still be checked by hand, `gh workflow run check.yml --ref <branch>` then
  `gh run watch`: it costs the same, so only for rare cases (a review asks for it, or the change is to the tests' own
  setup).
- Still write tests with your change: GitHub runs them. A new browser test goes in the `layout-*.test.ts` file of its
  topic (setup in `test/layout.ts`); split a file that grows past about 20 s.
- If someone runs tests here by hand anyway, they run at the lowest priority and never touch `~/.shepherdr`.

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
