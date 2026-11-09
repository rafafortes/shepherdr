# Upstream intake

Upstream is [eliasstravik/shepherdr](https://github.com/eliasstravik/shepherdr). We are the fork
[rafafortes/shepherdr](https://github.com/rafafortes/shepherdr) and our line is the branch `herdr-tui`: Shepherdr 2.0,
the plugin for the herdr terminal app (plugin id `herdr-projects`). Upstream went elsewhere after 2.0.0 — 2.1 rewrote
it on herdr-core, 3.x made it a layout for the Herdr desktop app — so nothing upstream does fits us by default.

This file says how we watch upstream, what a change must keep to come in, how we record the decision
([docs/upstream-ledger.md](upstream-ledger.md)) and how a release of our line is cut. The rules in `AGENTS.md`
("This fork") win over this file.

## How we track upstream

The `upstream` remote is fetch-only (its push URL is `DISABLED`), so a mistake cannot reach eliasstravik/shepherdr:

```sh
git fetch upstream --tags   # every release tag, read only
git fetch upstream v2.0     # upstream/v2.0, its own 2.0 line: the closest code to ours
```

Never `git push --tags` from this repository: it would publish upstream's 3.x tags on our fork. We publish only our
own `v2.0.<n>` tags (Releases, below).

**Last reviewed** (update these three lines at the end of every pass):

- upstream `main`: `fc17865a` "SHEP-152 Copy buttons always copy, on every device", 2026-11-09 13:21 +0100
- upstream tag `v3.1.28` (`9cc43dca`, 2026-11-09), the newest release
- upstream branch `v2.0` tip: `ebb17d58` "SHE-295: Build coordinator Autopilot (#490)", 2026-10-29 (unchanged)

Reviewed on 2026-11-09, the fourth pass: the 56 commits between `v3.1.14` and `main`'s tip, behind the fourteen tags of
3.1.15 to 3.1.28 (2026-11-07 13:58 to 2026-11-09 12:09 UTC), the last of them published while the pass ran and read
with it; every upstream commit after `v2.0.0` is weighed in [the ledger](upstream-ledger.md), the new ones in its 3.1.15
to 3.1.28 section. The pass before it read 3.1.11 to 3.1.14 (2026-11-06), the one before that 3.1.4 to 3.1.10, and the
first the 60 commits after `dc1b6782`.

## How we notice a new upstream release

One weekly check, no more than that: upstream ships nearly every day, most of it on the herdr-core line we do not track,
so the useful question is only whether anything new matters to us. It runs as the automation **Weekly upstream check**,
every Monday at 9:00 (America/Sao_Paulo), in the `shepherdr` space: one task in this repository, its brief these checks.
It reports in the chat (a card with only the new adopt and port rows, ranked) and in the ledger.

- **What it does:** `git fetch upstream --tags`, then compares `git tag --sort=-v:refname` and the tip of
  `upstream/main` with the "Last reviewed" lines above. Nothing new: it says so in one line and closes with no branch
  (`shepherdr task close`). Something new: it reads the new release notes and the commit subjects, weighs each
  improvement against 2.0's own code, writes the ledger's new rows and extends its ranked list, updates these
  "Last reviewed" lines, and merges that docs-only change itself. It then posts one artifact with only the new adopt
  and port rows, ranked, for the operator to pick from. It never adopts or ports anything on its own and never posts
  upstream.
- **Cost:** one task a week, minutes of it, and it keeps the ledger from drifting for months. The ledger's own rows are
  the record: nothing else is kept.

## What a change must meet

A change from upstream comes in only when it keeps all four of these. Any one of them failing is a skip (3.x fails
all four at once), or the idea is ported to 2.0's code instead of its herdr-core or Tailscale parts.

1. **The herdr terminal plugin.** Shepherdr stays a plugin that herdr installs, builds, starts and stops, and whose
   agents are herdr agents: `herdr agent list/read/prompt`, panes, `herdr plugin install`, the plugin actions. No
   herdr-core, no Herdr desktop app, and the plugin id stays `herdr-projects`: herdr refuses an update whose id
   changed, so a new id is how upstream keeps a 2.0 install from moving onto 2.1.
2. **Our own login, in front.** The web app keeps listening on loopback and stays reachable from the phone through
   the operator's own path: the lab-ingress Caddy reverse proxy over the VPN, with basic auth (no Tailscale, no
   identity header, no `tailscale serve`). Nothing in the change may make a request's origin or identity decide who
   gets in. The plugin's `share` action (upstream's `tailscale serve`) stays unused for us.
3. **pi task agents beside Claude Code.** pi is first-class: model and effort flags, the log reader (its chat shows
   its replies), the folder-trust handling, and the brief reaching it. pi runs on OpenCode Go and on the local models.
   Claude Code stays the coordinator and the reviewer line.
4. **What polylog-bridge relies on.** `~/www/hermes-assistant/host/polylog-bridge`, a timer on the operator's
   host, is the only outside consumer of our CLI, and it is what turns tester feedback into tasks. It uses exactly this, and any
   change that renames, reshapes or moves one of them breaks it:
   - `shepherdr task list --space polylog --json` — a JSON array; it reads each row's `id`, `title`, `status` and
     `sub` (those four, with the brief, are what it pushes to the VM and what its change digest is built from).
   - `shepherdr task show <ID> --json` — one object; it reads `desc` (the brief, shown to the testers' side),
     `status` (compared with the literal `done`, to tell a finished task from a running one; a failed `task show` is
     read as a task that is not there), and `said` and `facts` (an investigation's answer, sent back to the tester's
     thread after a gitleaks scan).
   - `shepherdr task tell <ID> <text>` — the output `Told <ID>.`, or `<ID> is held: …` when the machine is full
     (its pattern is `^(?:Told (ID)\.|(ID) is held)`, so "is held" has no `Told` in front).
   - `shepherdr task add <title> --brief <text> --space polylog [--set review=off --set merge=ask me first]` — the
     output `Added <ID>: …` (an investigation sets those two settings).
   - `shepherdr ready <ID> --summary "…" --facts "…"` — what an investigation task's brief tells the agent to run; its
     summary and facts are what comes back.
   - Task ids of the form `POL-12` (`^[A-Z]{2,5}-[0-9]{1,6}$`), the space named `polylog`, and `shepherdr` on `PATH`
     as the single interface (that command finds the newest plugin checkout and talks to the loopback server).
   - The data home `~/.shepherdr`: spaces, tasks, chats, settings, `outbox.json`. The bridge itself never reads those
     files, but the command's answers must keep meaning the same thing: a task's brief in `desc`, its state in
     `status`, a space's tasks under `polylog`, settings that a task can carry over.
   - What a call must keep: exit code 0 for "it worked" (anything else is read as a refusal or as Shepherdr not being
     there) and the one-line answers above on stdout or stderr, which the bridge reads merged.

## Verdicts

Every improvement in the ledger gets one of three, always with the reason:

- **adopt** — it fits our code as it is (a descendant of v2.0.0, which is our base) and can be cherry-picked or
  applied nearly as it is.
- **port** — the idea is right but upstream's code is not (herdr-core, the Herdr app, multi-machine, the 3.x web
  client): it is rewritten against 2.0's code.
- **skip** — it does not fit, or it costs more than it is worth; the reason says which of the four criteria fails or
  why the value is too low for us.

A row may add `later` (worth doing, not now), `for now` (a skip we may revisit) or `verify first` (find out on 2.0's own
code whether the failure even exists before writing anything).

## One task and one pull request per adopted item

- One improvement is one task in the `shepherdr` space and one pull request to `rafafortes/shepherdr`, base
  `herdr-tui`. Never two improvements in one pull request; a fix-forward of an adopted item is its own.
- A port brings the tests it needs, written for 2.0's code. Never trust upstream's suite as proof: the v2.0 line's
  own CI was red (see the ledger's first section), and 2.1/3.x test code that does not exist here.
- The task's brief names the ledger row it comes from (`docs/upstream-ledger.md`, its commit ids), so the PR and the
  ledger can be followed back to upstream.
- Never open an issue, pull request or comment on eliasstravik/shepherdr without the operator's explicit OK, and no
  task's agent does it on its own.

## How a release is cut

Only with the operator's yes, and patch bumps (`v2.0.1`, `v2.0.2`, …) unless they say otherwise.

1. On `herdr-tui`, with everything merged: `package.json` and `herdr-plugin.toml` carry the same version, and both are
   bumped in the release commit (they are the only two places with it).
2. `git tag -a v2.0.<n> -m "Shepherdr 2.0.<n>"` and `git push origin v2.0.<n>` (the tag only — never `--tags`).
3. Optionally a GitHub release on that tag, its notes written from the merged pull requests since the previous tag.
4. On a machine: `herdr plugin install rafafortes/shepherdr --ref v2.0.<n> --yes`, then the plugin's **start** action,
   which swaps the running server. Each install gets its own checkout; the previous one stays for rollback
   (`herdr plugin install rafafortes/shepherdr --ref v2.0.<n-1> --yes`, then start again).
5. Check after the swap: `shepherdr status`, `shepherdr doctor`, the app answers through the lab-ingress URL, and a
   real task runs end to end on pi.
