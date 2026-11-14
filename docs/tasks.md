# Tasks

- A task is one agent, started at once in its own git worktree and branch from its chosen base (`work/<n>-<slug>`). herdr makes
  the worktree (`herdr worktree create`) from the space's own herdr space (its coordinator's), so the task's herdr
  space nests under it in herdr's sidebar. With no herdr space of the repo open, herdr opens one for it, and Shepherdr closes
  it again with the last task if you never used it. Your own checkout is never touched. A fresh worktree gets a copy
  of the ignored files the repo's `.worktreeinclude` names (`.env` and the like); nothing else runs. A task has no
  settings: its brief is all the agent goes by. The coordinator writes the work and your wishes for it ("wait until I
  say go", "skip the review", "ask me before merging"), and Shepherdr ends every brief with its Settings block,
  one plain line per setting that shapes how the agent works, the source it follows: whether it is reviewed and by whom (the reviewer tags each finding critical, major, minor or trivial; the agent fixes
  those at or above Must fix, `review.mustFix`, major by default, and reviews again, at most Review rounds,
  `review.rounds`, 3 by default), and whether it merges on its own (by default once its own quick checks pass,
  without waiting for GitHub's checks), on its own after GitHub's checks, or asks you first, and the agent, model
  and effort it runs on (only so it knows). A line that differs from Shepherdr's default says who changed it: this
  space's setting, this machine's, yours for every machine, or set by the coordinator for this task (`task add --set
  review.rounds=1 --set merge="ask me first"`). The brief's own words win, so a wish for one task needs no setting
  changed. The task's chat shows the block at the end of its first message, the changed lines picked out. The rest is the agent's judgment, by its
  skills: whether to plan first, how to build and check it, what to fix after a review and what proof to show. Ask for another CLI, model or effort for one task and the coordinator adds
  `--agent`, `--model` or `--effort` to `task add`; for another reviewer, `--reviewer`, `--reviewer-model` or
  `--reviewer-effort`. Tap the task and you are in its agent's chat, where it asks, shows
  artifacts and tells you when it is done; the task's brief shows exactly what its agent got.
- Review rounds are a limit, so no agent reviews for ever, and raising it is its coordinator's alone: its agent counts each round
  (`shepherdr review <id>`) and stops at the brief's Review rounds. The same command picks the round's reviewer by the caps
  (the backup reviewer below): the round's reviewer holds a slot of the caps until `shepherdr review <id> --done`. A task that has used them all with its final
  commit still unreviewed says so in its chat; its coordinator gives it exactly one more with `shepherdr task
  review-more <id>`, once, only once they are all used, and its agent is woken with the round to run. `task show`
  records it.
- Want something noted but not started? Ask for it "for later": the coordinator adds it with `--later`, and its agent
  starts all the same, with "don't start yet, wait for a go" in its brief. It says in one line that it has it and the task shows To do (`shepherdr todo`).
  Tap it and you are in its chat, like any other: say go when you are ready, or say what to change. The agent decides
  from your words.
- "Do this after that" ("then", "once that is merged", "after SHE-12") queues it: the coordinator adds it with
  `--after SHE-12` (`shepherdr task queue <id> --after …` changes or clears it on a task that exists). It has no agent,
  worktree or herdr space while it waits: the task shows under Queued, its line naming what it still waits for
  (`after SHE-12, SHE-13`). Once they are all done (merged, or nothing to merge) and the machine has room, Shepherdr
  makes its worktree from the base as it is then and starts its agent on the brief and the go, and a small card in its
  chat says why it started. Tasks queued by 2.0.27 or earlier got an agent at once: `shepherdr task park` lists those
  and `--yes` puts away the ones that never began, so they wait the same way. A task of another machine is named with its machine first
  (`vm-str:SHE-12`), from the main machine's home space. If one it waits for is stopped or goes wrong, the queued task needs
  you, saying which; it goes back to waiting once that task is going again. Want it started early? Just write to it:
  its agent starts on the brief and your words, decides from them, and clears its queue itself when they are a go (a
  note leaves it queued).
- "Do this tomorrow morning" schedules it: the coordinator adds it with `--at "tomorrow 9:00"` (`"fri 8:15"`,
  `"today 18:00"`, `"2026-11-06 09:00"`, `"18:00"`) or `--in 6h` (`"90m"`, `"2 days"`, `"1h 30m"`), one or the
  other, in the time zone Settings sets (time.zone). Until then it has no agent at all and shows under Scheduled, its
  row saying when it starts (`Starts Tomorrow 9:00`, counting down as you read it); it never reads Needs you while it
  counts down. At its time it starts as any new task does: it takes Settings as they are then (not as they were when it
  was added: the brief's block, the agent and the reviewer are read at the start), waits for the machine's room
  (Settings → the machine, as Queued) and for what it was queued `--after`, and its chat says its time came. Added with
  `--later` too, its agent then reads the brief and waits for a go. A time that passed while Shepherdr was off starts
  it as soon as Shepherdr is back, and says so in its chat. Change or cancel it before it starts with `shepherdr task
  queue <id> --at "tomorrow 7:00"` (`--in 2h`) or `--at none`, which clears the time and starts it now (ask your
  coordinator: a task waiting for its time has no chat yet, so there is nowhere to write in it). A message to it, from
  your coordinator, is the go too: it starts at once, no longer waiting for its time or for the tasks it was queued
  after. Only a task that has not started can be scheduled.
- A task's dot comes from its agent alone: Working, Needs you (it asks, or waits for your reply), Scheduled (it waits
  for a time it starts by itself at, with no agent yet), Queued (it waits for other tasks), To do (it waits for a go, or
  is still starting up; a To do row is its title alone), Ready
  (`shepherdr ready`: finished, waits for you to merge it), Merging (`shepherdr merge` under way: GitHub's checks run,
  a rebase or the merge itself, nothing for you to do) and Done (`shepherdr merge`: Merged, or closed: Nothing to merge). The list and the task's chat always show
  the same. Once started, only the agent puts a task in To do; one that stops for any other reason needs you, except
  while work it started in the background (a reviewer subagent, a shell, a monitor) still runs and will wake it: that
  is still Working (shells alone for up to 10 minutes, since a server it started for you never wakes it; a shell
  running a headless reviewer of another CLI, `codex exec` or `claude -p`, counts as a subagent), unless its last
  words ask you something. A task that needs you says why in at most 40
  characters, never by pasting the agent's message and never in a model's words: a standard reason (Plan to approve,
  Asks permission, Signed out, Question for you, Waits for your reply), or the agent's own question cut to fit
  (from its question tool, its choice card, or the last sentence of its last message that asks). The tasks list, the
  card in its space's chat, alerts and coordinator news all say the same; the full message stays in the task's chat.
- A start that never becomes a turn is no silence either: a CLI that exited before its first turn, or a resume whose
  session is gone. Its last words come to the chat as a card, the task shows `Went wrong: …` and needs you instead of
  Working, and Shepherdr leaves it to you rather than starting it again in a loop (`start.ts`). One that was resuming
  a session that is gone starts a new one, with its brief again, and the chat says so. An agent that has not begun its
  turn about ten seconds after its brief was handed over shows its screen as a card: what tells a stuck start from a
  slow one is in [Chats](chat.md).
- A turn cut off by the model's provider (overloaded, at capacity, a rate limit, a dropped connection) is no question
  for you: Shepherdr waits and tells the agent, task or coordinator, to carry on, after 1, 2, 4 and 8 minutes. Meanwhile
  a task stays Working, its line saying why and when (`Provider overloaded · retry in 2m`). Only when the fifth try is
  cut off too does it need you (`Provider overloaded, still after 5 tries`); a coordinator says so in its chat, with an
  alert. Errors waiting can't fix (signed out, out of allowance, a model that isn't there) go in at once to the backup
  agent, a task's or a coordinator's, where one is set (below), and otherwise to you. Anything written to the agent
  starts the count again. Each CLI's log says what cut it off (`server/live/retry.ts` decides).
- **First in line.** A coordinator marks a task with `shepherdr task priority <id>` (or adds it with `--priority`), as
  for a fix of a red main or merge gate: it goes ahead of the other held tasks and past the machine's load, pressure
  and spacing, never past its slots, its space's own cap (Settings → Space) or a herdr that doesn't answer; what it is
  queued after still holds it. You start
  one that waits now, from its ⋯ (**Start now**) or `shepherdr task start <id>`: it is first in line and no longer waits
  for the tasks it was queued after or for its time, and starts at once when a slot is free (else at the next free one).
  **Start now with…** picks its worker too, the CLI, model and effort for this task's agent alone (the task's own
  `--agent`, never Settings': its reviewer and backups stay as Settings say), as for one you want on the DGX Spark while
  the others run on a plan. **Start with…** picks its worker and nothing more: it stays in line as it is and starts on
  that worker when its turn comes. Either way the worker you pick wins over the one its agent last ran on, whether that
  agent still waits in its worktree or is gone from it, its worktree too (a stop with no work puts it away; it is made
  again from its branch): it starts again on yours (a new session on another CLI), and only
  your worker's limits count, never the old one's. A plain Start now after Start with… keeps the worker picked. Both sheets show each CLI's and model's room under Settings → Limits, as the restart
  sheet does ([chat](chat.md)): one that is full, blocked or out can still be picked, and the line below says what then
  happens (a start now takes the first backup with room, or waits first in line). Settings' task agent, model or effort changed in Settings can go to the waiting tasks
  the same way, when you answer yes to its question (or `shepherdr set … --apply-waiting`), and so can the reviewer: a
  waiting task's brief names the new one, and its agent hears it at its turn: see [settings](settings.md).
- **Held for room.** A task waits for room as Queued, with no agent yet, and its row says why: `Waiting for a free slot`
  (the machine's slots are all taken), `Waiting for the machine` (its load, pressure or memory, or a herdr that doesn't
  answer), `Waiting for a free slot of <space>` (that space's own cap, Settings → Space, `space.maxTasks`, is full),
  `Waiting: every model ran out`, or `Waiting: cut-off tasks go back to work first`. Three more, for a limit set to 0 (see
  [settings](settings.md)): `This machine is set to 0 tasks` (`machine.maxTasks` 0: this machine starts no
  task), `<space> is set to 0 tasks` (`space.maxTasks` 0 for that space), and `Blocked: every model it may use is 0 allowed`
  (every model of the task's chain is blocked by a `models.maxAtOnce` 0: it starts once a limit changes, never by waiting).
  A task held for its space's cap is
  passed over: a task of another space with room starts past it in the same pass, and the space's held tasks start in
  turn (first in line, then oldest) as its own tasks end and free a slot. The machine's limit still comes first, so a
  space's cap never lets more tasks work than the machine has slots.
  - **A model's cap.** A task whose agent would run on a model at its most-at-once cap (`models.maxAtOnce`, one provider
    such as `pi.spark`, or one model key) reads `Waiting for a free slot of pi · spark (4 of 4 at once)`, naming the entry that is
    full. The order of the reasons is the machine's slots, the machine's load, the space's own models and cut-off tasks,
    the space's cap, then the model's: the row names the first one that holds the task. A task held for its model is
    passed over like a held space's: the tasks on other models start in the same pass, and its held tasks start in turn as
    the model frees up. A first in line does not pass it. What counts toward a model, and what does not, is in
    [settings](settings.md).
  - **A blocked model.** A model at 0 (`models.maxAtOnce`, `pi.spark=0`) is blocked: nothing starts on it. A task whose chain has
    another model with room starts there (`Started on Codex: pi · spark is blocked (0 allowed)` in its chat). A task whose every model
    is blocked is held with `waiting: every model it may use is blocked (0 allowed): change its agent or a limit`, and it is not
    waited for: release starts it only once a limit changes. A task whose chain has full models as well waits for those only.
  - **Its chain.** A task whose primary is at its cap starts on its first backup with room, not held (`Started on Codex: pi · spark
    is at its limit (1 of 1 at once)` in its chat). Held only when every harness of its chain is full or out, and its row names
    each one, short: `Waiting: pi · spark 1/1 · codex out` (its row's title, and its card and replies, say it in full: `Codex (default) (out until 17:00)`), ending
    `every model it may use is full or out`. A cut-off task's takeover skips the full backups the same way and, with none with
    room, waits (`Waiting: …`) until one frees. Its way back to the primary is in [settings](settings.md) (the caps and the chain).
- A space may have a **merge gate** (Settings → How tasks work → Merge gate, `merge.gate`, off by default; a task's own
  `--set merge.gate=…` wins): a command run in the task's worktree after its rebase and before it goes into main here
  (not through a pull request), with `SHEPHERDR_TASK` and `SHEPHERDR_BASE` set. Exit 0 lets it in, and the last line it
  printed goes into the merge commit; anything else, or 45 minutes without an end, refuses the merge with the end of its
  output, main stays as it was and the task is Ready again. Merges into one repo go one at a time, so the others wait
  while it runs; a `shepherdr merge` that asks meanwhile hears that the gate still runs. If main moved anyway while it
  ran, the branch is rebased on it and the gate runs again (three times at most). It is never a git hook: a hook that
  refuses an update leaves what it would write in the space's checkout. The gate runs detached, its words and exit code
  in files of their own, so a restart of Shepherdr (an update) leaves it running: the Shepherdr that comes back goes on
  from it and merges once it passes. A merge that only waited in line takes its place in line again by itself, in the
  order it had, and its agent hears how it went. A merge a restart cut short with nothing left of it (a gate that was
  stopped, or the merge itself halfway) is back at its turn, its row reading `Merge gate interrupted by a restart: run
  shepherdr merge again` and its agent told so.
- A space with a merge gate may also take **merge trains** (Settings → How tasks work → Merge train, `merge.train`: off
  by default, or 2 to 5, the most merges one train takes, the head included). When several merges wait in line here,
  the first one in line runs the gate once for them all: their changes are stacked on main, one on top of the other,
  and the gate runs once on the top of that stack, in the head task's worktree (detached there, so no task's branch
  changes). If it passes, each merge goes in as its own commit, with its task's words and the gate's last line, and the
  line `Merge train: A, B, C (one merge gate run)`. The riders are the next tasks in line with the same gate, whose agent
  is at rest and has read its messages. One whose change conflicts with the ones before it, or adds nothing to them,
  keeps its place and goes in on its own turn, as usual. Only merges made here take part (not GitHub pull requests).
  If the gate refuses the train, nothing of it lands: each member then goes alone once, on its own gate, before it rides
  a train again, and only the task whose change fails is told of the refusal. If main moves while the train's gate
  runs, the head goes alone and the riders wait in line as before. The server's log names each train decision and why a
  waiting merge was left out, one `shepherdr: ` line each (`server.log` in the server's run folder: the herdr plugin's state
  folder, or `run/` in Shepherdr's home, `~/.shepherdr` by default); a turn with nobody else in line says nothing.
- A merge that waits in line behind another, or runs its gate, past `shepherdr merge`'s 90 s: its agent is told to end
  its turn instead of polling, and Shepherdr wakes it with how it went (merged, refused with the gate's lines, or a
  conflict). Waiting in line or in its gate, a task holds none of the machine's slots: its repo's merges go one at a
  time already. Its row names the merge that runs now (`Waiting for the merge gate (POL-223's runs)`), and moves on
  to the next as each one ends. With a merge train, the head's row reads `Running the merge gate (a train of 3)` and
  each rider's reads `Going in with POL-223's merge train`; a rider's own `shepherdr merge` then answers that it went in
  with that train. A task written to after it reported (a coordinator's "rebase on main and merge") is
  working again, not done; its own `shepherdr merge` says it is done again, so it shows as Merging, never Needs you,
  while its agent waits as told.
- A task that goes back to work in the worktree it had (its agent starts again, the way back moves it to its primary, a
  backup takes it over, a queued task gets its go, or words take its agent back from rest: your answer on a card, the
  advisor's, a message to a task that waits on you, is To do or reported ready) is first brought up to its base: what was merged meanwhile (build
  settings, the check, its tools, AGENTS.md) reaches it at once instead of only at its merge. A clean worktree is rebased
  on the base; one with work not committed is left alone, and a rebase that conflicts is undone, so the worktree is
  always as it was or on top of the base. Its chat gets a small card (`Rebased on main: 3 new commits in main`), and its
  agent is told what came in, that AGENTS.md changed when it did, and, when it was not rebased, to commit and rebase at
  its next good point. The base is the one here, which merges keep up to date: nothing is fetched. An agent mid-turn (a
  permission, its CLI's own question) is never rebased under it.
- When a task's agent can't go on (out of allowance, signed out, its provider still down after the tries), its
  **backup agent** goes in, once (a start that fails leaves a later one to try again), then the next of its chain where
  that one can't go on either ([settings](settings.md#a-chain-of-backups)): Settings → Agents → Tasks → Backups →
  Backup (`task.fallback`, Codex unless set, or
  off), on its own `backup.model` and `backup.effort`. The same CLI as the agent that can't go on starts again on that model
  and effort and resumes its own session, so nothing is lost, its worktree and branch unchanged; another CLI takes
  over in the same worktree and branch, with the brief and a short handover: who it takes over from and why, the
  branch's commits, what lies uncommitted and the chat so far. Either way a card in the task's chat says who went in
  and why. If the backup can't go on either, isn't installed, or is set to a model its CLI doesn't have, the task
  needs you: its chat says why where a backup setting is the reason, and one that couldn't start at all shows as
  `Went wrong`.
- A coordinator that can't go on is backed up the same way, when Settings → Agents → Coordinators → Backups → Backup
  (`coordinator.fallback`, off unless set) is on: the two backups have their own model and effort, and the coordinators'
  own pair (`coordinator.fallbackModel`, `coordinator.fallbackEffort`) reads `backup.model` and `backup.effort` while it
  is at default, so one backup can be on Claude Code and the other on pi, each on a model its CLI has. The same CLI starts
  again on that pair with its session, or another CLI takes the chat over — a different conversation partner, which the
  card in the space says — with the chat so far and its open tasks, its tasks going on as they are, and on the
  coordinators' Model and Effort where they are set, else on the model and effort it ran on. Once, until you start it
  again yourself (⋯ → Restart agent, or `shepherdr restart`); off, a backup already gone in, or one unable to go in, the
  space's chat says so and you are alerted. A backup that is at its limit or out is never taken past it: the coordinator
  waits, and takes the first one with room over once it has room (see [Most agents at once](settings.md#models)).
- A reviewer has a backup of its own, and it is words in the brief rather than an agent Shepherdr runs: a reviewer is
  the task's own agent reviewing, so a reviewer that is out of allowance would leave that agent stuck at the review.
  Settings → How tasks work → Reviewer → Backups → Backup (`reviewer.fallback`, off until set, with
  `reviewer.fallbackModel` and `reviewer.fallbackEffort`) makes the brief's Reviewer line name it: "If that reviewer
  cannot run at all (out of allowance, signed out, its model is gone), review with … instead for that round only, and
  say in your summary that you did." Every round asks `shepherdr review <id>` which reviewer to use first, and the caps
  decide it: the primary when it has room and is not out, else the first backup that has (its answer says why, e.g. "Codex
  is at its limit, 4 of 4 at once"). The task's agent runs it as it runs the reviewer, as `<task-id>/Reviewer`, and counts
  that round like any other; nothing else about a review changes, and it is never a second opinion after findings. When every
  reviewer is full or out, the command waits up to 90 seconds, then tells the agent to end its turn; a round is counted only
  once a reviewer frees, and the agent is woken with the reviewer to use. Its reviewer holds a slot from the count until
  `shepherdr review <id> --done`, the task's report, stop or end, or 45 minutes after the round was counted (or after its
  agent's turn ended without `--done`). A restart of Shepherdr keeps no such slot (it is in memory, as the advisor's are): the
  agent's next `shepherdr review` counts and leases a new one, and a round that waited for a reviewer still waits for it. Set Everywhere, for a machine, for a space or by its coordinator for one task (`task add --set
  reviewer.fallback=pi`), the most specific winning; with none set, or with Review off, the line reads exactly as it
  always has.
  Shepherdr does not nudge an agent towards that backup, because it has no exact way to see a reviewer fail: the only
  failure it reads as a provider's is a cut-off turn of an agent it started itself (`retry.ts` on that chat's own
  `error` event, and `checkCut` needs the agent's record), and a reviewer is no such agent — headless, it is a shell
  the task's agent runs, whose log `activity.ts` reads for steps and turns only, and a subagent is background work of
  it. A nudge would rest on a guess, and a wrong one would send an agent to its backup reviewer over a normal finding.
  The brief's words are the trigger, and they are the way back too: every round asks `shepherdr review` first again, so a
  reviewer goes back by itself as soon as its primary answers (a task already running keeps the reviewer
  its own brief named); with **tell me** (below), Shepherdr also asks the primary reviewer whether it answers
  again while a backup reviewer is set, and says so ([settings](settings.md#when-the-primary-is-back)).
- **Going back.** Once the primary answers again, each agent still on a backup, and each one cut off for good on the
  primary itself, starts again on what Settings name, when it is idle — never mid-turn, never a paused task, never one
  asking you something — a free slot at a time and before any new task, with a card in its chat, and its backup may
  take over again the next time the primary runs out; at most three times a day per role and space, after which it
  waits for you. While every model of a space has run out, its new tasks wait instead of starting only to be cut off. Settings → Agents → When the primary is back (`backup.watchReturn`): **go back**,
  the default; **tell me**, a card in each chat still on a backup naming the way back (⋯ → Restart agent, or `shepherdr
  restart <id>`; for a reviewer `shepherdr set reviewer.model <id> --space <name>`, a plain set being Everywhere's),
  and nothing switches; or **off**. It goes back to what Settings name now, never to what ran before, and it is never
  a decision of the takeover itself.
- Status, coordinators' too, is what the agent reports of itself. Every Claude Code Shepherdr starts gets a settings
  file of its own (`--settings`, in `~/.shepherdr/hooks/`; your own settings are never touched) whose hooks record
  each event: a turn starts or ends, what still runs in the background as it ends, a permission prompt (a subagent's
  too), its question tool, a plan. A turn cut short (Esc, a prompt turned down) runs no hook; its transcript says it
  ended. herdr's reading of the screen counts only where the agent reports nothing: Codex (its hooks each need
  trusting in a dialog first, and it writes OSC 7501 itself, which herdr will pass on), pi (it tells only a turn's
  end), an agent started before this, or a menu up between turns that no hook tells of. One function (`statusFrom` in
  `server/live/agents.ts`) decides, so taking herdr's OSC 7501 program status once it passes that on is one change.
- An agent's own Shepherdr commands never ask: not `ask`, `status`, `ready` or `merge`, and not the verbs it works with
  all day — `task`, `automation`, `heartbeat`, `artifact`, `space`, `set`/`unset`, `alert`, `plan`, `pr`, `checks`, `todo`,
  `show`, `models`, `help`, `secret list` and `secret ask`. The settings file Shepherdr passes at launch carries a
  `PreToolUse` hook (`server/live/readers/own-commands.ts`) that allows exactly one plain call of that launch's own
  command path — the one Shepherdr puts on the agent's `PATH` — with one of those verbs, either bare or in the launch
  prompt's own `SHEPHERDR_CHAT="…"` form; the words after the verb pass as they are, as before. A coordinator therefore
  runs its Shepherdr commands without a tap; what those verbs change (a setting, a space, a task, a checklist, an
  artifact) is what the human asked it for, and a task's agent can only reach its own task's `todo`, `pr`, `checks`,
  `merge` and `status` — not its `set`, `automation` or `space`, which the command refuses to a task's agent only where
  it says so. Everything else keeps its card: `secret run` (it runs any program) and `secret env` (it writes a file),
  `secret elevenlabs`, a verb not on that list (`restart`, `mode`, `doctor`, the `project` alias), the bare name
  `shepherdr`, and a command line with anything after the command (`;`, `&&`, `|`, a redirect). The Merge setting is
  guidance the agent follows, as before: it is not a check the command makes.
- Claude Code's own Bash allow rules were the other way to do this, and upstream 2.1 does it that way: measured on
  2.1.318, a rule for `<path> status` also let `<path> status; echo hi` run, `secret run` included, which is why here it
  is a hook. An agent already running keeps the settings file it started with, so it asks until it is restarted. On
  another machine (a box) its helper records hooks but decides nothing, so its agents still ask. Codex runs without
  approvals; pi never asks for one.
- On a repo with a GitHub remote that `gh` is logged in to, each task gets a pull request. The shepherdr-agent skill runs
  `shepherdr pr <id>`: it pushes the branch and opens a draft (its title the task's, its words the agent's summary, the
  brief's gist and a "Generated with" footer), and pushes to it again after new commits. `shepherdr checks <id>` waits
  for GitHub's checks (merging waits for them only when Settings → How tasks work → Merge is "after GitHub checks", or the task's --set says so);
  failed ones go back to the agent to fix. Reporting it ready takes the pull request out of draft.
  While it waits, Shepherdr looks at it every two minutes and passes news on to the resting agent once, in
  `<shepherdr>` tags: a check that failed (its link and the end of its log) and new reviews and comments with words (a
  bare approval is not news). The agent decides what to do (shepherdr-agent says how); Shepherdr only passes it on.
  A pull request merged there by hand (squashed too) ends the task: it reads Done, merged, and no second pull request is
  opened for work that is in.
  Its number shows on the task's row, links from its chat's header and from the Done card. The remote is read live, as
  written and as git rewrites it (`url.insteadOf`), and `gh` is told the host (`GH_HOST`, such as `github.localhost`).
  No remote, or no `gh` login: tasks merge here, as below. Logged in but GitHub not answering: nothing merges until it
  does.
- The agent merges when its brief or you say so: `shepherdr merge <id>` squash-merges the branch into main.
  On GitHub that goes through its pull request (opened then if the agent never did), as soon as the agent's own checks
  pass (in Shepherdr: the whole check, `bun run check:local`, AGENTS.md), without waiting for GitHub's checks: where a
  repo's workflows run, they still do it on every push to main (and on the pull request), and only a failure GitHub
  already shows at that commit stops the merge.
  With Settings → How tasks work → Merge on "after GitHub checks", it merges only once GitHub's checks pass. Either way only
  at the commit this machine has (`gh pr merge --squash --match-head-commit`), then its branch on GitHub is deleted
  and main here is pulled, so Shepherdr's own update sees the merge. Failed checks are sent back to the agent. A branch
  behind main is merged as it is: rebasing it would make a new commit and run all of GitHub's checks again, and again
  each time another task lands meanwhile. Only a conflict with main is rebased (by `shepherdr merge` when git can, else
  by the agent), and when waiting for GitHub's checks they run on that commit before it merges. For a few hours after
  a task merges through its pull request, Shepherdr watches GitHub's runs on main: once one fails, the space's
  coordinator hears it once (news), with the failing run, the end of its log and the tasks merged since main was last
  green, and decides on a fix-forward task (Autopilot adds one by itself). It hears again only after main was green. GitHub's
  merge queue would test each one on top of the others, but it needs an organisation's repo. Elsewhere it is rebased
  and squash-merged into main here (and main pushed when there is a remote). Work of your own left uncommitted in that
  checkout stops this only when the merge would write over it, and the refusal names the file and says what to do; a
  merge that leaves it alone goes in, and your edit stays uncommitted (nothing is stashed, and nothing is reset). Then
  the task is marked merged. Once the agent's turn ends, the task is put away through herdr: the worktree removed (which
  closes its space and agent), then the branch deleted. Nothing is forced: a checkout with uncommitted changes, or a
  branch with work main lacks, is kept and said so (in the coordinator's news and in `shepherdr status`), and its space
  and agent close all the same.
  Something still running in its space puts it all off until later. You can also just ask its coordinator to merge it.
  Task agents learn the way from brief to merged from [shepherdr-agent](../skill/shepherdr-agent/SKILL.md): the review the
  brief's Settings block asks for (Settings → How tasks work → Review, Reviewer, Must fix and Review rounds, and the
  backup reviewer for a reviewer that cannot run at all; the agent runs
  it however it sees fit, a subagent or a
  headless CLI, and asks `shepherdr review <id>` for each round, which counts it, at most Review rounds, and names its reviewer), what the change broke, left
  undone or added beyond the brief; only the choices no experiment can
  settle as cards for you, and your yes before anything irreversible; the proof in one small artifact; ready with a facts line; then merge or ask. How to
  build and check the work is the agent's own judgment: Shepherdr only gives it the brief, your defaults and the house
  rules.
- One menu holds a task's controls: its row's ⋯ (a mouse finds it on hover; on a phone the ⋯ always shows, or hold the
  row) and its chat's ⋯ have the same ones. It ends a task three ways: Stop, Done and Delete. Stop closes its agent and
  its space and puts it in To do, its work kept (a worktree with unsaved or unmerged work stays, one with none goes with
  its branch), and writing to it opens it again and resumes it; Stop asks first. Done asks first only when work would
  stay unmerged. Delete always asks first. The menu also holds Pin and Restart agent, and Archive (a working task asks
  first: its agent stops) or Unarchive.
- A task with nothing to merge (an answer, research, or work no longer wanted) is Done: Done in its menu, or `shepherdr
  task close <id> [--summary "..."]`, or just ask its coordinator. Its agent stops, its space closes, its worktree and branch go when
  they hold nothing unsaved or unmerged (else they are kept, and it says so) and it shows in Done with its summary
  (Nothing to merge by default); its card in the space's chat says so. An agent whose `shepherdr ready` finds no changes on
  its branch goes straight to Done the same way. One whose branch's work is in its base already, though not as its
  commits (its pull request merged there by hand, a squash merge, or the work itself), is Done (merged) instead: ready
  says so, and no pull request is opened for what is in.
- `shepherdr task stop <id>` is Stop from the menu: it closes a task's agent and space and puts it in To do. Its work
  stays, as above. Writing to the task opens its space again (or makes a fresh worktree) and resumes its agent.
- `shepherdr task delete <id>` removes a task for good, and only when you plainly ask its coordinator to: its agent
  stops, its space closes (with anything else running there), its worktree, branch, chat log and record go, so it
  leaves every list, and nothing is posted. A worktree with uncommitted changes, or a branch with work main lacks, is
  refused with what it holds, unless `--force`. A merged task can be deleted too: its commits stay on main. Its number
  is never given out again.
- Archive a task from its ⋯ (its row's or its chat's), or ask its coordinator
  (`shepherdr task archive <id>`, only when you ask). It leaves every list and count but keeps its record, chat and
  summary: ⌘K finds it, and **Archived · 12** at the bottom of the tasks list shows a space's archived tasks, the
  latest first, each with Unarchive in its ⋯ (`shepherdr task unarchive <id>`). Archiving a working task asks first:
  its agent stops, as with `task stop`, and its work stays. Writing to an archived task brings it back. Done tasks
  (merged or closed) archive themselves after a week: Settings → Tasks → Archive Done after (`tasks.archiveAfter`: a
  number of days, or off; each machine keeps its own). `shepherdr task list` leaves archived tasks out; `--archived`
  lists them.
- The field at the top of the Tasks and the Artifacts lists filters them as you type (F gets to it on a keyboard):
  tasks by id, title, status line or summary, Done and archived ones too; artifacts by title or the task that made
  them. Esc clears it.
- Leftovers of merged or closed tasks are swept up when Shepherdr starts and every hour after (a merge updates main,
  and the restart that follows can cut a clean-up short). Only tasks Shepherdr made and finished are looked at, never
  one whose agent is at work or that you talk to again, never your own worktrees or branches, and nothing while herdr
  does not answer. A branch counts as merged when main holds its exact tree (what the squash merge made), when
  squash-merging it again would make its task's own squash commit (so nothing came after the merge, however main
  moved on since), or when merging it into main would change nothing.
- While a task's agent works, it says itself what it is doing and how far along it is, at the start and at each
  natural step: `shepherdr status <id> "Fixing the two failing tests" --done 40 --left 5m` (its instructions tell it
  to). Shepherdr guesses nothing: it shows what the agent said, and counts the minutes left down while it works. Its dot fills like a pie with
  the % done and the minutes left sit small under it in the same orange (`6m`, `<1m`); its row's second line says
  what it does in at most 40 characters, so the title and that line each keep the row's whole width. A third, fainter
  line says what its agent runs on, while it works, merges or waits on you with its agent there: its CLI, provider and
  model (`pi · Spark (local) · qwen3.8-flash-next…`, `Codex · gpt-6-sol`), cut short when it is long (no tooltip: a
  screen reader hears it in full, with the provider's name and the effort, `Runs on pi · Spark (local) ·
  qwen3.8-flash-next-mlx4-mtp-tensorfold (high)`), and the minutes left stay level with the second line. Its chat header
  says the same with the minutes at the end (`Fixing the two failing tests · ~6 min`). Coordinators report no
  progress: their typing dots say a message is on its way (at once for yours; for news, once the reply shows on its
  screen and isn't a hidden `<no-reply>`); while they only work in the background they show nothing (no dots, no word in
  the header). Task titles
  are at most 32 characters, so each fits one line on a phone. A line longer than 40 characters is cut at a word,
  and the agent is told so. An agent that waits on you keeps its last line, frozen at its % (its minutes stop too);
  once it reports ready, or waits for a go or for other tasks, it has none.

- New tasks capture their space's base branch when added. Use `shepherdr task add "Title" --brief "…"
  --base feature/topic --space NAME` to choose another target for just that task. Its list, chat and
  `shepherdr task show ID` show the target before merging. With an origin remote the branch must exist there and is
  fetched before work starts; without origin a local branch is required. GitHub write access (or a non-GitHub
  remote's push access) and local repository write access are checked before starting. A failed check starts no
  agent. A branch available only on origin gets a local counterpart when the worktree starts.
  Rebase, pull requests and merge use this captured target. A pull request retargeted on GitHub must be corrected
  before Shepherdr will merge it. Branch protection and merge rules still apply at merge time.
