# Working on Shepherdr

How to run, build and lay out the code: [README.md](README.md), Develop.

## This fork (rafafortes/shepherdr)

The operator's fork, used on their desktop since 2026-11-04 (herdr installs the plugin from it:
`github:rafafortes/shepherdr@<tag>`). Where this section and the ones below disagree, this one wins.

- **Branches.** `herdr-tui` is our line, the default branch: Shepherdr 2.0, the plugin for the herdr terminal app
  (plugin id `herdr-projects`). `main` mirrors upstream (eliasstravik/shepherdr, now 3.x on herdr-core and the Herdr
  desktop app): never commit to it. Upstream's own 2.0 line is its branch `v2.0` (42 unreleased commits after v2.0.0).
- **What we keep.** The herdr terminal app, our own login in front of the web app (a reverse proxy over our VPN, not
  Tailscale), and pi task agents (OpenCode Go and local models) beside Claude Code. An improvement from upstream's 2.1
  or 3.x comes in only when it fits these; port the idea to 2.0's code rather than its herdr-core or Tailscale parts.
- **Upstream is read only.** The `upstream` remote has no push URL. Never open an issue, pull request or comment on
  eliasstravik/shepherdr without the operator's explicit OK; our pull requests go to rafafortes/shepherdr, base
  `herdr-tui`.
- **Releases.** A tag `v2.0.<n>` on `herdr-tui`, only with the operator's yes (as below); `package.json` and
  `herdr-plugin.toml` carry the same version. The desktop moves to it with
  `herdr plugin install rafafortes/shepherdr --ref <tag> --yes`, then the plugin's start action swaps the running
  server.
- **Tests.** The Check workflow runs on pushes to `main` only, so nothing runs it for `herdr-tui` yet. Until that is
  set up, run `bun run typecheck` and the tests of the files you changed (`nice -n 19 bun test <files>`).
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
rule, it is repeated in every `CLAUDE.md`, `AGENTS.md` and `GEMINI.md` of the operator's projects.

## Tests

- No tests on this machine: it keeps the CPU for herdr, the server and the agents. While you work and before you
  merge, run only `bun run typecheck` (seconds). Don't run `bun run test`, `bun test`, `bun run test changed`,
  `bun run check` or any browser test here.
- Check what you changed on the screen by hand in your shared browser, for the proof.
- GitHub runs the whole check (types, every test with the browser tests, the build) after each merge: the Check
  workflow (`.github/workflows/check.yml`) on every push to main, not on pull requests. A red main reaches the
  coordinator, who has it fixed forward. A failure's log is `gh run view <run> --log-failed`.
- Running the whole check on your branch before merging, `gh workflow run check.yml --ref <branch>` then
  `gh run watch`, is for rare cases only (a review asks for it, or the change is to the tests' own setup): it costs
  Actions minutes.
- Still write tests with your change: GitHub runs them. A new browser test goes in the `layout-*.test.ts` file of its
  topic (setup in `test/layout.ts`); split a file that grows past about 20 s.
- If someone runs tests here by hand anyway, they run at the lowest priority and never touch `~/.shepherdr`.

## Plugins

- `definePlugin` (`src/kernel.ts`, `server/plugin-api.ts`) and the slots of `Registry` (`src/kernel.ts`) are a public
  contract: the human's own plugins in `~/.shepherdr/plugins` rely on them (README, Your own plugins). Change them with
  care, keep old names working where you can, update the README's list, and say so in your done summary.
- A plugin the human asks you to make for them goes in `~/.shepherdr/plugins/<name>/`, never in the repo.
