# Settings

- Settings (sidebar, or `,` on a desktop) holds the few app settings, in two groups. What agents are told: How tasks
  work, only words in each new brief's Settings block (review, the Reviewer a brief suggests, Must fix, Review rounds,
  merge), each row offering its exact line under Brief wording. How Shepherdr runs: the agent, model and effort tasks and
  coordinators start with (model:
  every model the CLI reports, searched once the list is long, the ones you pinned or picked last first; an id or alias,
  or default for the CLI's own; effort: default, lowest, low, medium, high, xhigh or max, each CLI taking it its own
  way, and in words on screen — Extra high for xhigh) and tasks' backup agent, when Done tasks archive themselves, Autopilot's heartbeat (its trigger) and checklist, the time zone of every schedule, each machine's limits, the idle browser, dictation, Notifications
  and Voice. Notifications gathers scoped delivery rules and device enrolment; device delivery is Everywhere. Space menus still offer Notify. Its
  defaults are set Everywhere, for a machine or for a space (`shepherdr set <key> <value> [--machine | --space NAME]`, from any machine);
  the most specific one set wins. Editing above the content names the scope; its searchable hierarchy handles many machines and spaces. Values set here are highlighted, with their inherited value, source and Reset beside them. And, kept on each device, its Appearance: System (the device's own light
  or dark), Light or Dark, set before the first paint, with the browser's bar and artifacts following it. A phone
  lists the sections in groups, as iOS's Settings does, and opens one over the list; a wider screen keeps the list
  down its side.
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

## Claude Code login

Settings → Agents → Claude Code → Login (`claude.login`) picks how every Claude Code Shepherdr starts signs in:
`subscription` (the default: the claude.ai login you already use, exactly as before this setting) or `api` (an Anthropic
API key). Set it Everywhere, for a machine or for a space, like the other rows, or with
`shepherdr set claude.login api [--machine | --space NAME]`; `shepherdr show` says which one each level uses.

- The key is the secret `ANTHROPIC_API_KEY` in Secrets, kept by you: Settings → Secrets, or in your own terminal
  `shepherdr secret set ANTHROPIC_API_KEY [--machine | --space NAME] < file`. Never paste it into a chat. Picking `api`
  for a level with no key there (or above it) is refused, and a Claude Code whose key is gone is not started at all, so
  it never quietly falls back to the subscription.
- With `api`, Shepherdr gives each Claude Code a settings file of its own (`--settings`, beside its hooks) whose
  `apiKeyHelper` is a small script of Shepherdr's: Claude Code runs it when it needs the key, and it prints
  `ANTHROPIC_API_KEY` from the vault. The key is in no launch argument, no environment an agent's tools inherit, no
  brief, chat, card or log. Your own Claude Code sessions are never touched: nothing changes in `~/.claude/settings.json`,
  `~/.claude.json` or the global environment.
- Coordinators, Claude Code task agents and headless reviews (`claude -p`) all follow it. With `api`, a new brief's
  Settings block has a Login line with the exact review command:
  `claude -p --settings <the space's review settings file> "<prompt>"`; that file names the helper, which fails when the
  key is gone instead of letting the review use the subscription. With `subscription` a brief is exactly what it was, so
  a review from a brief written before a switch to `api` still runs on the subscription.
- When it takes effect: coordinators, task agents and reviews that start after the change. A running coordinator keeps
  its login until it starts again (a restart, or a relaunch after it stopped); its chat offers the restart the way a
  model change does, and its + menu and the restart sheet show the login it runs on.
- A wrong or revoked key makes Claude Code retry for a few minutes before it gives up (401, its own retries), so a
  review can sit quiet that long: replace the key in Secrets and restart.
- `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` in the environment herdr hands its panes would win over the helper
  (Claude Code's own order): Shepherdr sets neither, so leave them out of herdr's environment when you pick `api`.
- Owner-only files are the limit, as for every secret ([agent secret access](secrets.md)): any agent running as your
  user (a pi task agent included) can run the helper command named in those settings files, or read the vault, and get
  the key. Use a key with a spending limit, or separate OS accounts, if that matters.

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
already-running agent. Start a new agent or explicitly restart it to deliver changes. On resume, a changed prompt
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
