# Backups

All of Shepherdr's own work lives in a few files in its home, `~/.shepherdr` (`SHEPHERDR_HOME` moves it): the tasks with
their briefs, status and reports, the spaces, the settings, the automations, the agents' chats, and the plan usage read
from their logs. Each is one JSON file written whole, and the writes are atomic, so a crash never leaves half a store.
Nothing in that keeps a write that reads back fine from replacing hours of work: a typo in a setting, a delete confirmed
in a hurry, a release that writes wrong state for days before anyone notices. A snapshot is that net.

## What a snapshot is

```sh
bun scripts/snapshot.ts                    # tonight's snapshot, in ~/.shepherdr/backups/<date>/
bun scripts/snapshot.ts list               # the snapshots kept, newest first, with each one's size
bun scripts/snapshot.ts restore <date>     # put one back (stop Shepherdr first, below)
```

Run it from Shepherdr's checkout, or from a release's folder; it reads `SHEPHERDR_HOME`, or `~/.shepherdr` when that is
not set. Each run prints its date, how many files and bytes it took, how many it shared with the night before, and how
many snapshots are kept. It ends non-zero when a store could not be copied, naming it: a snapshot missing a store is a
failed run, never a quiet one.

**It holds:** every JSON file in the home's own folder — the stores of record (tasks, spaces, settings, automations) and
the caches that are hours of work too (the agents and their chats, the usage ledger, the outbox, the returns, the task
status lines) — and the task-ID store with the two files SQLite keeps beside it (`task-ids.sqlite`, `-wal` and `-shm`),
which are copied together because a database alone means nothing.

**It never holds:**

- the secrets: `secrets.json`, `vapid.json`, `push.json` and `vault.json`, the vault your keys are kept in — and any
  file whose name says it holds one, whether or not this page lists it;
- anything outside the home's own folder: no chat log (`chatlog/`), no attachment you sent (`inbox/`), no artifact's
  files (`artifacts/`), no other machine's payload (`machines/`). A backup must not duplicate a secret or a chat, and
  none of those is a store that nothing re-derives;
- the server's own `server.json`, and the copies kept beside a store (`.corrupt-…`, `.before-empty-…`, and the `.bak-…`
  you make by hand): a snapshot of copies would only cost space.

A snapshot holds the stores, not the work they point at. A task's worktree, its branch and its commits are in git, in
your space's repository; a release is in `.releases/`; the agents' own CLI sessions are in their CLIs' folders. What a
snapshot gives back is what Shepherdr itself knows.

## Retention

The newest 14 days, then one snapshot for each of the 4 weeks before them (the day a week stands for is its newest one,
so a week is kept by its last night). A store whose bytes did not change is a hard link to the night before rather than
a second copy, so a night costs what actually changed that day. On this machine the stores are about 20 MB, so 18
snapshots are at most about 350 MB, less whenever files are shared.

A run is one folder per day: a second run on the same day replaces that day's folder instead of adding another. The
folder is built beside the old one and renamed into place whole, so a run killed halfway leaves last night's snapshot —
never a half one — and the next run clears what it left.

## Putting one back

1. Stop Shepherdr: `herdr plugin action invoke herdr-projects.stop` (or quit the action that started it).
2. `bun scripts/snapshot.ts list` names the days kept; `bun scripts/snapshot.ts restore 2026-11-18` puts one back.
3. Start Shepherdr again the way you usually do, and look at the tasks and settings it now shows.

The restore refuses while a server runs in that home, naming its pid: its saves would write over what was put back and
its next read would see half of each. It stops nothing itself, and it changes nothing when it refuses.

What a restore costs: it copies the day's files over the live ones, so anything newer is gone with them. If tonight's
snapshot already exists and you want it kept too, copy its folder aside first
(`cp -a ~/.shepherdr/backups/<date> /tmp/`). A restore brings back the tasks, spaces, settings and automations of that
day, the agents' chats, and the task numbers their ID store held. It does not bring back a worktree, a branch or a
commit (they are in git), an agent that was running then, or a chat line written after that day.

## A schedule

This page installs none: how the copy runs is your choice, and the script does one snapshot whenever it is run. Three
ways to make it nightly, in the order that fits Shepherdr:

- **A Shepherdr automation** — one task a night, whose agent runs the script and reports the line it printed, visible in
  the space's chat like any other task:

  ```sh
  shepherdr automation add "Nightly store snapshot" --task "Snapshot Shepherdr's stores" \
    --space shepherdr --when "FREQ=DAILY;BYHOUR=3;BYMINUTE=0" \
    --brief "Run \`bun scripts/snapshot.ts\` in Shepherdr's checkout and report the line it prints."
  ```

- **A systemd user timer** on the machine that runs Shepherdr — no agent, no task, at the check's own low priority:

  ```ini
  # ~/.config/systemd/user/shepherdr-snapshot.service
  [Service]
  Type=oneshot
  WorkingDirectory=%h/path/to/shepherdr
  ExecStart=/bin/sh -c 'exec nice -n 19 ionice -c 3 bun scripts/snapshot.ts'
  ```

  ```ini
  # ~/.config/systemd/user/shepherdr-snapshot.timer
  [Timer]
  OnCalendar=*-*-* 03:00:00
  Persistent=true

  [Install]
  WantedBy=timers.target
  ```

  `systemctl --user enable --now shepherdr-snapshot.timer` turns it on; `journalctl --user -u shepherdr-snapshot` shows
  the lines it printed.

- **A cron line**, if you have cron already: `0 3 * * * cd <checkout> && nice -n 19 ionice -c 3 bun scripts/snapshot.ts`.

Any of them runs one snapshot a night; the run itself starts no agent, opens no port and calls nothing outside this
machine.
