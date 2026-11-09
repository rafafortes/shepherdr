# Settings

- Settings (sidebar, or `,` on a desktop) holds the few app settings, in two groups. What agents are told: How tasks
  work, only words in each new brief's Settings block (review, the Reviewer a brief suggests, Must fix, Review rounds,
  merge), each row offering its exact line under Brief wording. How Shepherdr runs: the agent, model and effort tasks and
  coordinators start with (model:
  every model the CLI reports, searched once the list is long, the ones you pinned or picked last first; an id or alias,
  or default for the CLI's own; effort: default, lowest, low, medium, high, xhigh or max, each CLI taking it its own
  way, and in words on screen — Extra high for xhigh) and the backup agents that take over when a task's or a
  coordinator's agent can't go on, whether one of those is told when its primary answers again, when Done tasks archive
  themselves, Autopilot's heartbeat (its trigger) and checklist, the time zone of every schedule, each machine's limits, the idle browser, dictation, Notifications
  and Voice. Notifications gathers scoped delivery rules and device enrolment; device delivery is Everywhere. Space menus still offer Notify. Its
  defaults are set Everywhere, for a machine or for a space (`shepherdr set <key> <value> [--machine | --space NAME]`, from any machine);
  the most specific one set wins. Editing above the content names the scope; its searchable hierarchy handles many machines and spaces. Values set here are highlighted, with their inherited value, source and Reset beside them. And, kept on each device, its Appearance: System (the device's own light
  or dark), Light or Dark, set before the first paint, with the browser's bar and artifacts following it. A phone
  lists the sections in groups, as iOS's Settings does, and opens one over the list; a wider screen keeps the list
  down its side.
- A reviewer has a backup, for the case where it cannot run at all. Settings → How tasks work → Reviewer → Backup
  reviewer (`reviewer.fallback`, off until you set one) names a second reviewer CLI; `reviewer.fallbackModel` and
  `reviewer.fallbackEffort` are its model and effort, its own keys so that neither reviewer replaces the other. When
  it is set, the brief's Reviewer line ends with it: “If that reviewer cannot run at all (out of allowance, signed
  out, its model is gone), review with … instead and say in your summary that you did.” It is still one reviewer a
  round, run by the task's agent as `<task-id>/Reviewer`; it never changes what a review means (findings, the bar, the
  rounds), and it is never a second opinion after findings. With it off (the default) the line reads exactly as before.
  Like the rest, it is set Everywhere, for a machine or for a space (the most specific one set wins), and for one task
  by its coordinator (`task add --set reviewer.fallback=pi`), which wins for that task.
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

Settings → Agents → Backup holds both backups in one group: two CLIs, each with its own Model and Effort — the
coordinators' pair reads the tasks' pair until you set its own. They go in when an agent can't go on (signed out, out of
allowance, its provider still down after the retries): a task's agent keeps its worktree and branch, a coordinator's
tasks go on as they are, and either way it happens once, so a backup that keeps failing waits for you.

- **Tasks' backup** (`task.fallback`, Codex unless set, or off): the CLI a task's backup goes in on — the task's own
  `task add --set task.fallback=…` first, then its space's, this machine's and Everywhere's.
- **Coordinators' backup** (`coordinator.fallback`, off unless set): the CLI a coordinator's backup goes in on — its
  space's own, then this machine's, then Everywhere's. Another machine's coordinator follows its own machine's settings.
- **Model** and **Effort** (`backup.model`, `backup.effort`, default): the tasks' backup's own pair, read at the most
  specific level that sets it — a task's own `--set backup.model=…` (or `backup.effort=…`), else its space's, else this
  machine's, else Everywhere's. Where it is default, a backup starts on the model and effort the agent it backs up ran
  on, when the backup's CLI has them.
- **Coordinators' Model** and **Effort** (`coordinator.fallbackModel`, `coordinator.fallbackEffort`, default): the
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

## Tell me when it is back

A backup stays in place until you go back to the primary yourself — a restart for a task or a coordinator, a Settings
key for a reviewer — so a model that comes back to life went unnoticed. Settings → Agents → Backup → **Tell me when it
is back** (`backup.watchReturn`, on unless you set it off; Everywhere, for a machine or for a space, the most specific
one set wins) asks the primary now and then whether it answers again, and tells you in the chats that are still on a
backup.

- **When it asks.** After a takeover for a reason waiting can't fix (out of allowance, signed out, a model that is not
  there, a provider's refusal — never an error that passes by itself), the primary is first asked about half an hour
  later, and while it still doesn't answer each wait doubles — an hour, then two, then four, the longest — with a fifth
  of the wait either way at random, so a machine's roles do not fall due together. A probe is one tiny request through
  that CLI: one line in, one word out, no tools, no session kept, a hard timeout — and, with Claude Code and pi, its own
  coding assistant's prompt and the person's MCP servers and settings left out (Codex is run in its read-only sandbox, on
  its own config). It runs only while none of this machine's agents is working, one at a time, and never at boot. It is
  nobody's turn: no chat line, no herdr pane, no agent's secret, and its own failure is silent for you — no card, no
  alert, nothing to answer, nothing of its words in a chat (the server's log says why, for the day it needs explaining).
- **What it tells you.** One card in each chat still on the backup — each task's, the coordinator's own, the space's
  for a reviewer, which has none of its own — saying that the primary answers again and how to go back: `shepherdr
  restart <task or space>` (or ⋯ → Restart agent) for a task or a coordinator, and for a reviewer `shepherdr set
  reviewer.model <id> --space <name>` — the space's own, since a plain set would change every space's reviewer — with
  nothing restarted: a new task's brief reads it, a task already running keeps the reviewer its brief named. And an
  alert, where your Notifications let one through. One card per recovery: a primary that keeps answering posts nothing
  more, and a chat that already went back gets nothing. The chats it names are the ones still running on what took over;
  nothing is said to a role whose Settings name the harness it runs on.
- **Which roles.** The roles whose primary can be in use somewhere else: the tasks' agents, the coordinators and the
  reviewer, each probed as Settings name its primary — the tasks' pair, the coordinators', the reviewer's
  (`reviewer.agent`, `reviewer.model`, `reviewer.effort`). For a reviewer the card names `reviewer.model`, where the
  backup reviewer's own model is `reviewer.fallbackModel`. Shepherdr never starts a reviewer, so it never sees one fail:
  a backup reviewer being set is what it knows of a reviewer whose primary can't run, and while one is set at a level of
  Settings (with Review on, on a CLI of its own) the primary reviewer is what it asks, so you can go back to it; one a
  coordinator set for a single task (`task add --set reviewer.fallback=…`) is that task's, and is not watched. A role
  whose primary is the harness in use is never asked: a backup set to the same harness as the primary, or the backup reviewer itself, which
  has no backup of its own, leaves nothing to come back to.
- **What it never does.** It never switches anything: no setting is written, no agent restarted, no model chosen — the
  card is the whole action. It never asks another machine's models (the record lives in this machine's
  `returns.json`), never asks a CLI that isn't installed here, never asks one Shepherdr has no silent one-shot for
  (only Claude Code, Codex and pi have one), and it is never part of the takeover's decision: the probe reads, and
  nothing else.

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
