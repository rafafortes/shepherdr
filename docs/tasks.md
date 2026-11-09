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
  (`shepherdr review <id>`) and stops at the brief's Review rounds. A task that has used them all with its final
  commit still unreviewed says so in its chat; its coordinator gives it exactly one more with `shepherdr task
  review-more <id>`, once, only once they are all used, and its agent is woken with the round to run. `task show`
  records it.
- Want something noted but not started? Ask for it "for later": the coordinator adds it with `--later`, and its agent
  starts all the same, with "don't start yet, wait for a go" in its brief. It says in one line that it has it and the task shows To do (`shepherdr todo`).
  Tap it and you are in its chat, like any other: say go when you are ready, or say what to change. The agent decides
  from your words.
- "Do this after that" ("then", "once that is merged", "after SHE-12") queues it: the coordinator adds it with
  `--after SHE-12` (`shepherdr task queue <id> --after …` changes or clears it on a task that exists). Its agent starts
  at once, reads the brief and waits; the task shows under Queued, its line naming what it still waits for (`after
  SHE-12, SHE-13`). Once they are all done (merged, or nothing to merge), Shepherdr tells its agent to go,
  and a small card in its chat says why it started. A task of another machine is named with its machine first
  (`vm-str:SHE-12`), from the main machine's home space. If one it waits for is stopped or goes wrong, the queued task needs
  you, saying which; it goes back to waiting once that task is going again. Want it started early? Just write to it:
  its agent decides from your words, and clears its queue itself when they are a go (a note leaves it queued).
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
- When a task's agent can't go on (out of allowance, signed out, its provider still down after the tries), its
  **backup agent** goes in, once (a start that fails leaves a later one to try again): Settings → Agents → Backup →
  Tasks' backup (`task.fallback`, Codex unless set, or
  off), on its own `backup.model` and `backup.effort`. The same CLI as the agent that can't go on starts again on that model
  and effort and resumes its own session, so nothing is lost, its worktree and branch unchanged; another CLI takes
  over in the same worktree and branch, with the brief and a short handover: who it takes over from and why, the
  branch's commits, what lies uncommitted and the chat so far. Either way a card in the task's chat says who went in
  and why. If the backup can't go on either, isn't installed, or is set to a model its CLI doesn't have, the task
  needs you: its chat says why where a backup setting is the reason, and one that couldn't start at all shows as
  `Went wrong`.
- A coordinator that can't go on is backed up the same way, when Settings → Agents → Backup → Coordinators' backup
  (`coordinator.fallback`, off unless set) is on: the two backups have their own model and effort, and the coordinators'
  own pair (`coordinator.fallbackModel`, `coordinator.fallbackEffort`) reads `backup.model` and `backup.effort` while it
  is at default, so one backup can be on Claude Code and the other on pi, each on a model its CLI has. The same CLI starts
  again on that pair with its session, or another CLI takes the chat over — a different conversation partner, which the
  card in the space says — with the chat so far and its open tasks, its tasks going on as they are, and on the
  coordinators' Model and Effort where they are set, else on the model and effort it ran on. Once, until you start it
  again yourself (⋯ → Restart agent, or `shepherdr restart`); off, a backup already gone in, or one unable to go in, the
  space's chat says so and you are alerted.
- A reviewer has a backup of its own, and it is words in the brief rather than an agent Shepherdr runs: a reviewer is
  the task's own agent reviewing, so a reviewer that is out of allowance would leave that agent stuck at the review.
  Settings → How tasks work → Reviewer → Backup reviewer (`reviewer.fallback`, off until set, with
  `reviewer.fallbackModel` and `reviewer.fallbackEffort`) makes the brief's Reviewer line name it: "If that reviewer
  cannot run at all (out of allowance, signed out, its model is gone), review with … instead and say in your summary
  that you did." The task's agent runs it as it runs the reviewer, as `<task-id>/Reviewer`, and counts that round like
  any other (`shepherdr review <id>`); nothing else about a review changes, and it is never a second opinion after
  findings. Set Everywhere, for a machine, for a space or by its coordinator for one task (`task add --set
  reviewer.fallback=pi`), the most specific winning; with none set, or with Review off, the line reads exactly as it
  always has.
  Shepherdr does not nudge an agent towards that backup, because it has no exact way to see a reviewer fail: the only
  failure it reads as a provider's is a cut-off turn of an agent it started itself (`retry.ts` on that chat's own
  `error` event, and `checkCut` needs the agent's record), and a reviewer is no such agent — headless, it is a shell
  the task's agent runs, whose log `activity.ts` reads for steps and turns only, and a subagent is background work of
  it. A nudge would rest on a guess, and a wrong one would send an agent to its backup reviewer over a normal finding.
  The brief's words are the trigger.
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
  headless CLI, and counts each round with `shepherdr review <id>`, at most Review rounds), what the change broke, left
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
  what it does in at most 40 characters, so the title and that line each keep the row's whole width. Its chat header
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
