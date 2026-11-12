# Settings

- Settings (sidebar, or `,` on a desktop) holds the few app settings, in two groups. What agents are told: How tasks
  work, only words in each new brief's Settings block (review, the Reviewer a brief suggests, Must fix, Review rounds,
  merge), each row offering its exact line under Brief wording. How Shepherdr runs: the agent, model and effort tasks and
  coordinators start with (model:
  every model the CLI reports, searched once the list is long, the ones you pinned or picked last first; an id or alias,
  or default for the CLI's own; effort: default, lowest, low, medium, high, xhigh or max, each CLI taking it its own
  way, and in words on screen — Extra high for xhigh) and the backup agents that take over when a task's or a
  coordinator's agent can't go on, whether one of those is told when its primary answers again, when Done tasks archive
  themselves, Autopilot's heartbeat (its trigger) and checklist, the time zone of every schedule, each machine's limits and each space's cap on its working tasks, the idle browser, dictation, Notifications
  and Voice. Notifications gathers scoped delivery rules and device enrolment; device delivery is Everywhere. Space menus still offer Notify. Its
  defaults are set Everywhere, for a machine or for a space (`shepherdr set <key> <value> [--machine | --space NAME]`, from any machine);
  the most specific one set wins. Editing above the content names the scope; its searchable hierarchy handles many machines and spaces. Values set here are highlighted, with their inherited value, source and Reset beside them. And, kept on each device, its Appearance: System (the device's own light
  or dark), Light or Dark, set before the first paint, with the browser's bar and artifacts following it. A phone
  lists the sections in groups, as iOS's Settings does, and opens one over the list; a wider screen keeps the list
  down its side.
- **The tasks already created** (`task.agent`, `task.model`, `task.effort`). A task's CLI, model and effort are fixed when
  it is added, so a change here reaches the tasks added after it. Right after you save one, Settings asks **Apply to the
  tasks already created?** when a waiting task would change, with what it would do: "2 waiting tasks of herdr-projects
  (queued, To do, scheduled) start on pi (high) when their turn comes. Running tasks keep their agent." **Apply to 2 tasks**
  sets each waiting task's worker the way Start with… does (for that task alone; it stays in line as it is, and one whose
  agent already sits in its worktree is restarted on the new worker at its go). **Only new tasks** changes nothing. With no
  waiting task that would change, nothing is asked. The result (how many changed, how many were already on it) stays in the
  dialog until you press Done.
  - **Which tasks.** Waiting means queued (after others, or held for room), To do and scheduled. Running, asking, ready,
    merging, done and archived tasks keep what they run on, and so does one already on the new worker. A scheduled task
    with no CLI of its own takes Settings when it starts, so it needs nothing; one the way back is starting again starts
    on what Settings name for its role, too.
  - **Which spaces.** A change of a space's own setting reaches that space's waiting tasks. A change at Everywhere or this
    machine reaches the waiting tasks of every space of this machine that does not set that key itself: a space with its
    own setting keeps it, and the dialog says which ones ("gtm keeps its own setting."). Tasks of the home space are not
    among them.
  - **Chosen at task add.** A task whose CLI, model or effort a coordinator set with `task add --agent`, `--model` or
    `--effort` changes too, and the dialog counts those apart ("1 of them was given its own worker when added, and changes
    too"). Once changed it runs on Settings like the others.
  - **From the command.** `shepherdr set task.model <model> --space NAME --apply-waiting` (also `task.agent` and `task.effort`, with
    `--machine`, or Everywhere without `--space`) makes the same change and says in one line what it did, with the same counts.
    Without `--apply-waiting` nothing waiting moves.
- A reviewer has a backup, for the case where it cannot run at all. Settings → How tasks work → Reviewer → Backup
  reviewer (`reviewer.fallback`, off until you set one) names a second reviewer CLI; `reviewer.fallbackModel` and
  `reviewer.fallbackEffort` are its model and effort, its own keys so that neither reviewer replaces the other. When
  it is set, the brief's Reviewer line ends with it: “If that reviewer cannot run at all (out of allowance, signed
  out, its model is gone), review with … instead for that round only, and say in your summary that you did; every
  round asks that reviewer first again.” So a reviewer goes back to its primary by itself, the next round after it
  answers again. It is still one reviewer a round, run by the task's agent as `<task-id>/Reviewer`; it never changes what a review means (findings, the bar, the
  rounds), and it is never a second opinion after findings. With it off (the default) the line reads exactly as before.
  Like the rest, it is set Everywhere, for a machine or for a space (the most specific one set wins), and for one task
  by its coordinator (`task add --set reviewer.fallback=pi`), which wins for that task.
- Merge gate and Merge train (How tasks work, `merge.gate` and `merge.train`), per space like the rest. The gate is a
  command a merge made here must pass (exit 0) before it goes into main. The train (2 to 5, the most merges one takes,
  the head included; off by default) lets the first merges in line go in together on one gate run, each as its own
  commit. It needs a gate set and works only for merges made here, not through a GitHub pull request. Off means one at
  a time. What each row does is in [tasks](tasks.md).
- **Max tasks of this space working at once** (`space.maxTasks`, the Space section; off by default, or 1 to 200) caps how
  many of one space's tasks work on this machine at once. It works together with the machine's own limit (Machine → Max
  tasks working at once, `machine.maxTasks`): a task starts only when the machine has a free slot and its space is under
  its cap, so the caps never add up past the machine's limit. Off means only the machine's limit. Set it Everywhere, for
  a machine or for a space; the most specific one set wins, as for the rest. For example, a machine at 9 tasks at once
  with `lyvora-app` at 6 and `product-intel` at 2 (`shepherdr set machine.maxTasks 9 --machine`, `shepherdr set
  space.maxTasks 6 --space lyvora-app`, `shepherdr set space.maxTasks 2 --space product-intel`): lyvora-app may have 6 of
  its tasks working, product-intel 2, and a space with no cap of its own only has the machine's limit left, never more
  than 9 in all. A held task of a space at its cap reads `Waiting for a free slot of <space>` and the other spaces'
  tasks start past it; a first in line does not pass the cap either, and the way back honours it too. What waits and
  why is in [tasks](tasks.md) and [machines](machines.md).
- Secrets (How Shepherdr runs) holds the keys, tokens and passwords agents use, by name: add, replace and remove them
  in masked boxes, Everywhere, for a machine or for a space; the most specific one wins. An agent that needs one asks
  with `shepherdr secret ask NAME --why "…"`: its chat shows a masked box, and the agent is told by name once it is
  kept. Agents run commands with them (`shepherdr secret run NAME -- <command>`, which masks them in what the command prints) or write them to a file git ignores
  (`shepherdr secret env NAME --file .env`), and never see them in a chat, a terminal or a log. All of them are kept
  in one file on the main machine, readable by you only (`~/.shepherdr/vault.json`); a value goes to another machine
  only when an authenticated agent there uses one, over its SSH link. Agent credentials bind access to that agent’s
  own space and machine; loopback or a forwarded socket alone grants nothing. See [agent secret access](secrets.md)
  for provisioning and the upgrade steps for already-running agents.

- Interactive task, coordinator and backup chat choices require both runtime log discovery and a chat reader.
  Settings and Restart offer Claude Code, Codex and pi; other herdr CLIs are refused before a chat launch because
  their replies cannot be shown. Existing saved choices are kept, but an unsupported choice must be changed before
  launching again. Headless reviewer choices are separate; this does not add or prove support for other reviewers.

## Backup agents

Settings → Agents shows each role's backups under the role's own rows, in a Backups sub-block (indented, under its
own small heading): the tasks' under Tasks, the coordinators' under Coordinators, the advisor's under Advisor. Each
backup is a CLI with its own Model and Effort — the coordinators' pair reads the tasks' pair until you set its own.
They go in when an agent can't go on (signed out, out of allowance, its provider still down after the retries): a
task's agent keeps its worktree and branch, a coordinator's tasks go on as they are, and either way it happens once,
so a backup that keeps failing waits for you.

- **Backup** under Tasks (`task.fallback`, Codex unless set, or off): the CLI a task's backup goes in on — the task's own
  `task add --set task.fallback=…` first, then its space's, this machine's and Everywhere's.
- **Backup** under Coordinators (`coordinator.fallback`, off unless set): the CLI a coordinator's backup goes in on — its
  space's own, then this machine's, then Everywhere's. Another machine's coordinator follows its own machine's settings.
- **Backup model** and **Backup effort** under Tasks (`backup.model`, `backup.effort`, default): the tasks' backup's own pair, read at the most
  specific level that sets it — a task's own `--set backup.model=…` (or `backup.effort=…`), else its space's, else this
  machine's, else Everywhere's. Where it is default, a backup starts on the model and effort the agent it backs up ran
  on, when the backup's CLI has them.
- **Backup model** and **Backup effort** under Coordinators (`coordinator.fallbackModel`, `coordinator.fallbackEffort`, default): the
  coordinators' backup's own pair, set at the same levels, so that it can be on a CLI other than the tasks' one and on a
  model that CLI has. While it is at default it reads `backup.model` and `backup.effort`, so every configuration in use
  keeps its meaning and its row shows the value it reads, saying it comes from the tasks' backup.

A model no backup that reads it can take — at the level it is set and every level below that reads it — is refused when
you set it in Settings; one a backup's CLI lacks where it goes in, such as one set for a single task with `--set`, or one
the other role's backup can take while the coordinators' pair follows it, is not used there, so that backup doesn't go in
and its chat says why (and its Model row says so too). Effort it lacks becomes the nearest it takes. Only a backup that
changed the CLI is a takeover; the same CLI again keeps the session it had. A task's backup goes in once (a start that
fails leaves a later one to try again); a coordinator's once, until you start it again yourself.

A backup on the CLI the agent already runs starts that CLI again on the Backup model and effort and resumes its own
session, so nothing is lost; another CLI takes the work over — a task's with its brief, its branch and the chat so far, a
coordinator's chat with its open tasks and its chat so far, which changes who you talk to — and the card in that chat says
who went in and why. A backup that isn't installed, or set to a model its CLI doesn't have, doesn't go in: the chat says
why. Each value shows where it comes from, with Reset to the inherited one, like every other setting.

### A chain of backups

Each role's backup is the first of a chain: **+ Add a backup**, at the end of that role's Backups sub-block (Tasks,
Coordinators, Reviewer, Advisor), adds the next under its last one, up to five, each with its own CLI, Model and Effort
(Backup 2, Backup 2 model, Backup 2 effort …)
(`task.fallback2`, `task.fallback2Model`, `task.fallback2Effort` … `task.fallback5…`; `coordinator.fallback2…`,
`reviewer.fallback2…`, `advisor.fallback2…`). The new one starts on the CLI of the one before it; Off takes it out. They
go in turn: where the agent on Backup 1 can't go on either, Backup 2 takes over, the same way (the same CLI resumes its
session, another CLI takes the work over with the handover), each once, and past the last one it waits for you. One
that is off, isn't installed or is set to a model its CLI lacks is passed over for the next. A backup reviewer's chain is
the brief's Reviewer line, each in turn for that round only; the advisor's is tried in turn on a question. A task's
own `task add --set task.fallback2=…` wins in its chain, as for Backup 1. `shepherdr show` lists only the ones on. The
way back still asks the primary alone: an agent on any backup of the chain starts again on the primary once it answers,
and its chain is whole again for the next time; every model of a role has run out once its last backup is cut off too.

## When the primary is back

A backup takes over by itself when the primary can't go on; this is the way back. Settings → Agents → **When the
primary is back** (`backup.watchReturn`, in a Backups group of its own at the end: it applies to every backup above;
Everywhere, for a machine or for a space, the most specific one set wins)
asks the primary now and then whether it answers again, and then:

- **go back** (the default): each agent still on the backup — each task's, the coordinator's — and each one cut off for
  good on the primary itself (it had no backup, its backup couldn't start, or the backup ran out too and it waits for
  you) starts again on what Settings name for its role, once it is idle: never mid-turn, never a paused task, never one
  asking you something (a question, a plan, a choice). The same CLI resumes its session; another takes over with the
  chat so far (a task's: its brief, commits and changes too), as a restart does, and a start that had gone wrong is
  over once it starts. Its chat gets a card ("Back on the primary model, which answers again: …", or "Started again on
  …: its provider answers again") and the agent is told why it was started again; one alert per return. A task takes a
  free slot as a new one would (Settings → the machine → Max tasks working at once, and its space's cap if it has one), so a night's worth of them comes
  back a slot at a time, and while some still wait for one no new task of that space starts ("Waiting: cut-off tasks
  go back to work first"). The ones still busy follow on later passes, a minute apart, without asking the primary
  again while its answer is fresh (a quarter of an hour); after that it is asked again first, and while some can't go
  back yet (a pause of days) each answer makes the next question wait twice as long, up to four hours. Each chat once
  per outage, and one pass at a time, so no agent is started twice. Going back gives the backup its one go back: the
  next time the primary runs out, the backup takes over again.
- **Every model out.** When the backup is cut off too, or there is none, a new task of that space waits instead of
  starting only to be cut off as well ("Waiting: every model ran out"), until the primary answers; the tasks already
  cut off then go back first.
- **Cut off before it was kept.** A chat cut off for good, or still on the backup that took it over, that no outage
  covers (cut off before Shepherdr kept outages, or whose note was lost) is taken in on the watch's next pass: its
  primary is asked at once, as its cut-off is old, and it goes back like any other. Each cut-off or takeover once per
  server run, and never one the way back already started again.
- **tell me**: nothing switches. One card in each chat still on the backup says that the primary answers again and how
  to go back — `shepherdr restart <task or space>` (or ⋯ → Restart agent) for a task or a coordinator, and for a
  reviewer `shepherdr set reviewer.model <id> --space <name>` — and an alert, where your Notifications let one through.
- **off**: it never asks.

`on`, this setting's other value before going back by itself came, reads as **tell me**.

What it goes back to is always what Settings name for that role now, never what ran before: a model you set by hand is
the primary from then on. To lean on a backup for a while, leave Settings as they are and let the backup take over by
itself; going back undoes it once the primary answers. A role whose Settings name the harness its agents run on has
nothing to come back to, and is never asked.

- **When it asks.** After a takeover for a reason waiting can't fix (out of allowance, signed out, a model that is not
  there, a provider's refusal — never an error that passes by itself), the primary is first asked about half an hour
  later, and while it still doesn't answer each wait doubles — an hour, then two, then four, the longest — with a fifth
  of the wait either way at random, so two roles rarely fall due together. A probe is one tiny request through that
  CLI: one line in, one word out, no tools, a hard timeout. Claude Code and pi are asked with their coding assistant's
  prompt and the person's MCP servers and settings left out, and keep no session; pi does load its own extensions, which
  is how a provider one of them adds (a pi package) is asked at all. Codex runs in its read-only sandbox with its own
  config, and may keep its rollout file. An agent of this machine at work on that very model, with no cut-off of its own
  and none in that outage for ten minutes (a turn already under way when the provider began refusing may still be
  working a while), is the answer itself, and nothing is asked. One cut-off after another keeps the schedule of the
  first: a night of them never puts the question off. One at a time, and never at boot. It is nobody's turn: no chat line, no herdr pane, no agent's secret, and its own failure is
  silent for you — no card, no alert, nothing to answer, nothing of its words in a chat (the server's log says why, for
  the day it needs explaining — an option its CLI is too old to know shows up there too).
- **Never a loop.** A role and space go back by themselves at most three times a day. A primary that runs out again
  each time leaves the next return to you: its chats get the tell me card instead, saying so, and a day later the count
  starts over.
- **Which roles.** The tasks' agents and the coordinators, each as Settings name its primary — the tasks' pair, the
  coordinators'. The reviewer has nothing to move: Shepherdr never starts one, and every review asks the primary
  reviewer first and falls back only when it can't run (the brief says so), so going back is already what each review
  does. With **tell me**, a backup reviewer being set is what Shepherdr knows of a reviewer whose primary can't run:
  while one is set at a level of Settings (with Review on, on a harness of its own: another CLI, or another model or
  effort) the primary reviewer is asked, and the card in the space's chat names `reviewer.model`, where the backup
  reviewer's own model is `reviewer.fallbackModel`; one a coordinator set for a single task (`task add --set
  reviewer.fallback=…`) is that task's, and is not watched. A backup reviewer set Everywhere is one alert, and one card
  in each space's chat, since each space reviews with its own Settings.
- **What it never does.** It never writes a setting and never chooses a model: going back is a restart on what Settings
  name. It never asks another machine's models (the record lives in this machine's `returns.json`), never asks a CLI
  that isn't installed here, never asks one Shepherdr has no silent one-shot for (only Claude Code, Codex and pi have
  one), and it is never part of the takeover's decision.

## Advisor

A task's agent or a coordinator often waits on a question you can't answer well: a choice between libraries, a design
trade-off, what a test failure means. Settings → Agents → **Advisor** (`advisor.agent`, `advisor.model`,
`advisor.effort`; off until you set one, Everywhere, for a machine or for a space) names a model that answers them,
and **Backup** (`advisor.fallback`, `advisor.fallbackModel`, `advisor.fallbackEffort`) the one that answers where it
can't run at all, as every other role has one.

- **On your word.** Each question card the advisor can take — a choice card, one question of the CLI's own question
  tool, a plan — shows **Ask the advisor** beside Dismiss. Its answer comes back as a card of its own: what it picks (or
  its words), why, and which model said it, with **Send it** (the question is answered as you would, in your name) and
  **I'll answer myself** (the question stays as it was).
- **By itself.** A question nobody answered goes to the advisor once it has waited **Answers for you after**
  (`advisor.after`: 2 min unless set; off never sends one by itself). A sure answer goes to the agent at once, named as
  the advisor's (`from="The advisor"`), with a card in the chat (what it answered and why) and an alert. A task's plain
  question in words (its last words ask you something, and nothing else holds it) gets an answer in words the same
  way. A plan is never sent by itself: it only ever gets a suggestion.
- **What it never decides.** A permission, a terminal's own screen, a provider's cut-off, a start that went wrong or a
  login are never its to answer, and it leaves to you — a card says so, and the question keeps waiting — anything it
  is not sure of, and anything that would decide a permission, deleting or losing work, force-pushing, changing
  Settings, secrets or credentials, merging past "ask me first", spending money or a paid plan, or what touches a live
  site or other people.
- **How it runs.** One headless run per question, read only: Claude Code with Read, Grep and Glob only, pi with its
  read, grep, find and ls tools, Codex in its read-only sandbox; no MCP servers, no session kept, no agent's secret,
  in the task's worktree (a coordinator's folder for its own questions), for at most eight minutes. It reads the
  question and its options, the brief, the chat so far and the repository, and ends with one line of JSON: its pick or
  words, why, and whether it is sure. One question at a time, each once (`advice.json` keeps what it was asked).

## Dictation

Talk to type (the microphone beside the message box) records in the browser with `MediaRecorder`, sends the
recording to the machine that serves Shepherdr, and that machine writes it down with **whisper.cpp**: `ffmpeg` turns
it into a 16 kHz mono wav, whisper transcribes it, and the recording and the wav are dropped with the temporary
folder they lived in. The words come back into the message box to edit, at the cursor; Cancel drops them. It is the
same in every browser, which is why the browser's own speech recognition is not used: Android Chrome's types nothing
at all, silently.

Settings → Dictation (Everywhere or one machine) has what it needs:

- **Model**: the model file, `~/.local/share/shepherdr-whisper/ggml-base.bin` unless set elsewhere. It must be a
  multilingual model (`ggml-base.bin`, not `ggml-base.en.bin`), so one machine writes down more than one language.
  Download: `curl -L -o ~/.local/share/shepherdr-whisper/ggml-base.bin
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin`.
- **Language**: Detect it (whisper works the language out itself), English or Portuguese. A whisper language code
  (`es`) is also accepted.

whisper.cpp itself installs from the Ubuntu archive (`sudo apt install whisper.cpp`), which provides
`whisper-cli`; Shepherdr finds it on `PATH`, then at `/usr/bin`, `/usr/local/bin`, `~/.local/bin` and Homebrew's
prefix. A recording goes up at most 20 MB. When whisper.cpp, `ffmpeg` or the model is missing, the chat says so in
words — it never fails silently — and nothing of the recording is written anywhere.

## Private instructions

Settings → Private instructions has three small text fields: Coordinators, Task agents and Reviewers. Each uses the
existing Everywhere / machine / space picker and Reset. For each role separately, the most specific value set wins:
space > machine > Everywhere > empty. Values are not concatenated across scopes. Save an empty value to suppress
inherited rules for that role; Reset restores inheritance. Backup agents use Task agents' rules. Home coordinators
use their home space's settings, then the machine's and Everywhere's.

These are personal rules, stored in `~/.shepherdr/settings.json` (or `SHEPHERDR_HOME`), outside the shared repo.
They use the existing settings propagation to other machines: Everywhere comes from the main machine; each machine
keeps its own machine and space values. No repository `AGENTS.md`, `CLAUDE.md`, override file or worktree copy is
created or changed. Keep passwords, tokens and keys in **Secrets**, never here: this text is visible in settings,
agent prompts and session history. Agents must never copy it into git, task briefs, proof reports or GitHub.

Private rules supplement repository/team rules. Explicit human instructions and the task brief take precedence over
private rules. A conflict with team rules must be surfaced to the human, not silently resolved by replacing them.
Shepherdr's normal role prompt and skills still apply.

A new launch snapshots the role's current effective instructions. Claude Code and pi use the existing appended
prompt file; other CLIs receive the existing hidden initial prompt. Saving does not interrupt, restart or update an
already-running agent. Start a new agent or explicitly restart it to deliver changes: the chat's own ⋯ → Restart
agent… (`shepherdr restart <space|id>`) is the one that hands a running coordinator or task agent its new private rules.
`shepherdr restart --all`, and this machine's ⋯ in the places list, restarts only the coordinators whose agent, model or
effort moved in Settings — not one whose instructions alone changed — so it is no way to deliver these words; [the chat
page](chat.md) says what it does and does not touch. On resume, a changed prompt
is sent again for CLIs without an append flag; it says the new private snapshot replaces the previous one, including
when empty. This delivers words, not proof that a model read or obeyed them; old session history is still present.

Reviewers are started by task agents, not by a separate settings service. A task launch includes a clearly marked
reviewer-only snapshot and tells the task agent to pass that snapshot, privacy/precedence rules and repository rules
to every headless or subagent reviewer, without applying reviewer rules to itself or passing task-only private rules.
Changes to reviewer rules therefore need a new task agent or an explicit restart of the existing task agent too.

The CLI uses the same fields, for example:

```sh
shepherdr set task.instructions "Keep replies short." --space my-space
shepherdr set coordinator.instructions "Ask before adding tasks." --machine
shepherdr set reviewer.instructions "Pay extra attention to data loss."
shepherdr unset task.instructions --space my-space
```

Text is limited to 16,000 characters per field. These settings are not part of the saved task brief or its Settings
block, and are not per-task `task add --set` options.
