# Chats

Every agent, coordinator or task agent, gets the same chat.

- Pick a space; write to its coordinator. Ask it for a task; tasks are created only through a coordinator.
- Name a space or a task in what you write: type `#` in the box for its spaces (each with its machine, when there are
  several) and `@` for its tasks, the ones waiting on you and at work first and Done last, each with its state, its id
  and its title. A pick stays as plain words while you type (`#gtm`, `@SHE-12`) and goes in as
  `[#gtm](space:p:vm-str:gtm)` or `[@SHE-12](task:SHE-12)`, so the agent reads which space or task you meant and the
  message draws it as a chip that opens it. Arrows choose and Enter or Tab takes a row, a tap on a phone, and Escape
  closes the list for the words typed. One typed by hand, never picked, goes as the words it is (`#gtm` stays `#gtm`,
  and two spaces with the same name, a `home` on each machine, share the last one picked); a pick is kept with the draft
  it was made in, so the reload of a new build brings both back. A `#` or `@` inside a word (an email, a link's
  `#anchor`) is only words, and so is one in an agent's reply inside code, or one it escaped. How an agent acts on a
  mention is in the shepherdr skill.
- What you send shows in the chat the moment you tap Send, faded until it is in. If it can't go through, it says so
  under the message, with Retry and Remove; it is still there after a reload.
- Write to a busy agent any time: it goes in at once and steers the agent mid-turn (Claude Code, Codex and pi take it
  at their next step). It waits only while the agent shows a menu or permission prompt, where typed text could pick an
  option (the bubble says so, and it goes in once the prompt is answered), or while the agent is still starting.
  Commands like /compact or a model change wait for the turn to end. One Claude Code is holding in its own queue says
  Queued under it, with Send now: that presses its own Ctrl+Enter, and only while its screen offers it, so the agent
  reads it mid-turn instead of at its next step.
- Startup trust and MCP approval prompts appear as choice cards, even before the first message. The card keeps the
  CLI's screen text and offers Open terminal if it cannot read the choices. Answers are checked before messages go
  in. Only task worktrees Shepherdr creates are pre-trusted in Claude Code and Codex; a space you picked still asks.
- Every question, permission and plan card has Dismiss in its header, and Esc once you pressed the card (a press on
  one of its choices or its box keeps the keys there). It closes without an answer and the agent hears the person
  declined it, so it carries on with its own judgment and says what it assumed; a dismissed permission is never a yes,
  and a dismissed plan is not approved. A dismissed card says Dismissed, its copy in the space's chat too, and the
  space's coordinator hears a decline rather than an answer. A start stopped on its own screen has no Dismiss: Esc
  there would end the launch, and Open terminal is the way on. A CLI's own prompt takes the person's own Esc and then
  the words of the decline; a menu a slash command opened takes only the Esc, since it asks the agent nothing.
- An agent that has not begun its turn about ten seconds after its brief was handed over (nothing in its log, no
  session) shows what its screen shows as a card, and the task counts as Needs you. It reads the screen through
  herdr for every CLI the same way (`server/live/screen.ts`): the choices it can read are one-tap answers, pressed in
  the terminal exactly as the card shows them; a screen with nothing to read still comes with its words, and Open
  terminal is the way on. What tells a stuck start from a slow one: a screen that keeps saying something new (a step, a
  word, a percentage that grows) is a slow start and never a card, however long it takes, and neither is a screen at rest
  whose brief already went in (pi on a cold local model takes a while); a screen that rests and cannot take the brief, or
  says something went wrong, is a card. An agent that is working never gets one, and one back on an older session is
  never read from its words (its screen is a transcript, not a start): it is a card only when what was handed to it
  still cannot go in.
- A start or a resume that fails is no longer silence: its chat says what the CLI printed last (`Claude Code couldn't
  start: …`), and its task shows `Went wrong: …` and needs you, instead of Working for ever. One that was resuming a
  session that is gone starts a new one instead, told its brief again, and says so in the chat. Nothing starts it
  again by itself; your next message tries again. A launch herdr has not finished yet (issue #491) is left to herdr.
- The + menu's agent controls (Agent, Model, Effort) say what its CLI reports it runs on; a tap opens Restart agent on
  any of them. The model list holds every model the CLI reports — pi's whole lineup across providers — with a search box
  once it is long (by a model's name or its id), the models you pinned first and the ones you picked last next, and the
  effort levels in words (`xhigh` reads Extra high). A tap on a row's pin keeps that model at the top of its CLI's list
  from then on (the arrow keys reach it too, and Enter pins). Pins and recent picks belong to this machine, kept in
  `~/.shepherdr/model-picks.json`, never in a browser, so every device sees the same ones; Settings' model rows show
  them first too.
- Changing Settings never restarts a running agent: it goes on the CLI, model and effort it started with, and the
  restart sheet opens with what it runs on beside what Settings say now. A restart is one you run: its ⋯ (Restart
  agent…) or `shepherdr restart <space|task id>` — the same CLI resumes its session, another takes the chat over with
  the chat so far, a working agent's turn is interrupted first, and a card in the chat says what it is on. A model at its
  limit or blocked under [Most agents at once](settings.md#models) is refused before anything stops or is saved, with
  the reason. The sheet shows it before you pick: each CLI and model in its lists says its room under Settings → Limits
  for this chat's space (`1 of 2`, `2 running`, faint and marked `Full 2 of 2`, `Blocked` or `Out until 17:00`, and a
  quota window past its warning share, `5 h 92%`), counting what runs now but not this chat's own run, and the one picked
  has a line below with what holds it or how much room it has, the tasks that run there and its provider's quota; on a
  full or blocked one, Restart stays off.
- **Switching model or effort without a restart.** The restart sheet's **Switch to** button changes a running agent in
  place, on the same CLI and the same session, so its turn, worktree and branch are untouched; the CLI's own commands
  go in between turns and nothing is saved in Settings. It appears only when an idle agent's model or effort pick
  differs on a CLI with a switch of its own, and the chat shows the new model from the agent's own log before the
  action finishes — no restart card and no new launch:
  - **Claude Code:** `/model` and `/effort`; its `Set model to …` and `Set effort level to …` lines in the session log
    say what it now runs on. Those commands also save the pick as the default for new sessions, so the keys they touched
    in the CLI's own settings are read and put back afterwards: only this agent keeps the new model, other sessions and
    Shepherdr's Settings keep theirs.
  - **pi:** `/model <provider/model>` and `/thinking <level>`; its `model_change` and `thinking_level_change` log
    entries are the same ones the chat already uses to show its current model and level.
  - **Codex:** `/model`'s picker, choosing the level for this session only (`s`, never Enter), confirmed by its
    `thread_settings_applied` log line. Codex is not installed on this host (removed 2026-10-15), so this path comes
    from upstream's Codex 0.163 and is covered by a fake screen and log, not by a local run.
  - **OpenCode and agy keep the restart.** They do have in-session switches (OpenCode 2.3.0's `/models` and
    `model.cycle_recent`, agy 1.5.9's `/model` picker and `/effort <level>`; checked in their installed command
    registries, not just `--help`), but neither writes a line into its chat log naming the new model and level before
    its next turn, which is the proof this path requires. So the sheet offers only **Restart** for them, as it does for
    a different CLI or a permission change: that stops the turn first and resumes the session on the new settings.
    Their chat readers can name a model on the next assistant message, which is not a proof of the switch itself.
  A model full or blocked under [Most agents at once](settings.md#models) is refused for a switch as it is for a restart
  (the Switch button stays off beside the same room line), and a target or starting value the chat cannot name takes the
  restart path. A switch is refused while the agent is working or waiting on a question, so nothing can cut its turn. If any step
  fails — including a step that was typed but whose answer never came — both model and effort are put back on what
  they started with (a model switch can move the level on its own), and the chat must report the old values before the
  failure is shown. A switch to the CLI's own default is resolved to a concrete id and level first: where neither the
  target nor the starting value can be named from the chat, **Restart** is the only path. A switch the chat does not
  report is never taken as a success.
- One setting changed for every space is still one action. This machine's ⋯ in the places list carries the count —
  Restart 3 coordinators, and it is there only while some coordinator's Settings moved — and runs it, its answer in the
  row itself (the count, and the spaces that failed by name); `shepherdr restart --all` does the same from a terminal:
  every coordinator of this machine's spaces whose Settings now say other than what its agent ran on when it started
  (why a chat whose own pick differs while Settings did not move is left alone), one restart each exactly as above, one
  line per space (what it runs on and that it was left alone, counted; the failures last and named), and one space that
  fails never stops the others. It touches no task's agent — a running task's brief was
  written when it started, so restarting its agent is its own choice (`shepherdr restart SHE-12`) — and no other
  machine's space, whose coordinators are that machine's and its own command's; it says both in its answer. `--all`
  takes no space and no CLI, model or effort of its own: each coordinator goes on what its Settings say.
- A slash command you type (`/clear`, `/new`, `/compact`, `/model sonnet`, a custom one) goes into the agent's CLI as
  you typed it, once its turn is over, and the CLI runs it. The chat shows it as you typed it, and what the CLI printed
  as its answer — except a `/model` or `/effort` answer, which is read as the model and effort the agent now runs on,
  not posted as a message, so the composer shows the new value. After `/clear` or `/new` a quiet New session line starts the new session, whose log the chat reads
  from then on. A menu or view the command opens in the terminal (`/model` alone, `/usage`) comes into the chat and is
  closed, so your next message goes in; one that asks a question (Codex's `/new`: where should the new conversation
  run?) is a card to answer, and what you write meanwhile waits for it. A command the CLI didn't run fails with Retry.
- A message another agent sends an agent (a coordinator relaying what you said, a task agent reporting to its
  coordinator, two of your own sessions talking) is a row of its own: on the left in a shade apart from both bubbles,
  with the sender above it — the name that side declared, the herdr pane it wrote from, and the space or task it works
  in when the message says so. **The sender is declared, never verified**: it is another agent's text, not your word,
  and nothing about a permission, a merge or a secret is theirs to give.
  What is recognised, and how: `shepherdr task tell` run from an agent's shell (Shepherdr wraps its words in the
  envelope below, so every task it reaches knows who sent it), and from any pane herdr says an agent runs in, even one
  that is not Shepherdr's (`shepherdr task tell` from a plain Claude Code or pi session's shell, which has no chat of its
  own, goes by that pane's agent); herdr's own agent messaging, which wraps the message it types into a pi pane
  (`<agent-message from="…" to="…">`, the pi herdr integration's tool); and Claude Code's cross-session messaging, which
  its own log marks as a peer message. What is not: plain text typed with `herdr agent prompt`, or an answer typed into a
  blocked pane, carries nothing to tell it from your own words, so it still reads as yours; and a `shepherdr task tell`
  from a plain terminal with no agent in its pane is your own words, as always.
  One thing to know about the name: when it is one of the agents on this machine (`shep-she-17`, a pane id), the row
  shows that agent's own name, pane and space or task, which is what the machine knows about it — the message still
  only claimed the name. Shepherdr's own lines to its agents are tagged the same way and are never shown as a message:
  a brief, a piece of news, a go.
  ```
  <agent-message from="SHE-17 agent" to="SHE-18 agent" pane="w7R:p2" space="shepherdr" task="SHE-17">Merge it once the checks pass.</agent-message>
  ```
  How it reaches the chat differs by CLI, though the row looks the same: Claude Code's own log marks a cross-session
  message as a peer line (`origin.kind: "peer"`), which its reader turns straight into that row; Codex, pi, OpenCode and
  Antigravity receive the `<agent-message>` envelope typed into the pane, which the chat reads as a row naming the
  sender. Either way, a card or a question the agent asked before it is answered by that message as far as the chat
  knows (it is the prompt the agent will read next), so it leaves Needs you — the same rule as the human's own words,
  hidden notes included, and never Shepherdr's own news (SHE-53, SHE-54). There is a test per CLI in
  `test/wait-alerts-source.test.ts`.
- An agent's own pictures and videos reach its chat, sent with `shepherdr attach <file> --caption "…"` (the shepherdr
  skill's "A picture or a video in your chat"): the file is copied into that chat's own inbox, as one you send is, and
  posted as a message of the agent's — the caption, then each file a message of its own, pictures sent together lying
  side by side (a video keeps a tile of its own). A picture draws as a tile and opens full screen, a video as a tile
  with its still that plays in place, and each carries a way to keep it. On a machine with ffmpeg a big picture is a
  thumbnail there (`server/live/media.ts`: made once, kept beside it in that inbox), a video's still likewise, and a
  GIF that moves or a drawing is shown as it is; a video on that machine is served a part at a time, so a phone starts
  it and seeks without downloading it again. A path a reply merely names, in markdown, is not drawn: the server serves only a file a
  chat really has, never whatever path a reply names (`attachment` in `server/live/source.ts`).
- Every chat shows what its agent does, calmly and in plain words (Claude Code and Codex, read from their logs). Just
  before a turn's last reply its steps sit as at most three quiet rows, each an icon for its kind (read, edit, run,
  search, web, subagent) and what it did: `Checked the task list`, `Edited 2 files: app.ts, panel.tsx  +12 −3`,
  `Ran tests: 41 passed`, `Searched the code for “review”`. Files read or changed group into one row, and the rows that
  say most (changes, test runs, failures) show first; `4 more · 5m` shows the rest. A tap on a row opens what it ran
  (the command, the path, the pattern) and its output or diff; no command line shows until then. The words come from
  the agent's own short description of a command (Claude Code's `description`), else from what the command runs
  (`git status` is `Checked git status`, `bun test` is `Ran tests`, an unknown program `Ran <its name>`), else the
  tool. While a turn runs, one quiet line in place of the typing dots says what it does now and for how long
  (`Checking the task list  12s`), coordinators' turns too (their header still says nothing of it). While work it
  started in the background runs (subagents, background shells and monitors, a headless `codex exec` or `claude -p`,
  which counts as a subagent), a small tag sits just above the message box (`1 subagent · 1 shell`), only in its own
  chat (task rows stay clean); a tap shows each piece, what it does now (its latest step, or its output's last line)
  and for how long, and each opens to its own steps or its recent output. Nothing streams by default and nothing
  flashes; a turn it answered with nothing (news it had nothing to say about) shows no rows.
- On a phone or tablet it behaves like an app: every screen it opens (a space, a task, the sidebar drawer, settings,
  search, a task's Files or Diff, an artifact) is a step back, so iOS's swipe back and Android's back go one step at a
  time (task, then space, then the sidebar) and an alert's link opens with its space behind it. Swipe from the
  left edge for the sidebar (left again to put them away), right across a task's chat or settings to go back, and down
  on a sheet's grabber to close it; each follows your finger, and a quick flick is enough. A message slid right still
  replies, and held it still reacts. Screens push and pop, sheets slide, menus spring, tasks glide between groups; with
  reduced motion they just fade. No pull to refresh: everything is live.
- On a desktop, or a tablet with a keyboard, everything works from the keyboard: press `?`. Option+↑/↓ (Alt off a
  Mac) goes to the space above or below in the sidebar, as it shows (headings and folded ones skipped), from
  anywhere, the message box too, and leaves you typing in that space's box.
- On a wide screen, drag a sidebar's inner edge to resize it (double-click resets). Hide the sidebar for more chat room
  with the button at its top or `⌘B`. Each device remembers its own.
- Split view, as Slack's: on a desktop the middle holds up to three panes side by side (as many as the window has room
  for), each a space's chat, a task's chat, an artifact or a space's tasks, with its own header and message box. Open
  one with **Open in split view** in a space's or task's ⋯, an artifact card or full screen, or a task's header ⋯, or
  `⌘`-click (Ctrl-click off a Mac) a space, a task or an artifact's title. The focused pane has a thin line along its
  top: the sidebar's selection, the lists on the right and the keys follow it, and a space picked opens in it. Drag
  the line between two panes to resize them (double-click shares the room evenly); each pane's header has **Make it
  the only one** and **Close pane**. Each device remembers its own; a phone or tablet shows one at a time, as always.
- A task's chat has a side panel, like T3 Code's: on a desktop a column right of the chat, opened with the toggle at
  the end of the task's header, resized by its edge, its tabs **Terminal**, **Files**, **Diff** and **Pull request**
  (open or shut, width and tab remembered on the device); on a phone or tablet the same items in the task header's ⋯,
  each a full-screen sheet that Back closes (on a desktop its ⋯ lists them too). Every chat's ⋯, a task's or a
  coordinator's, starts with **Search in this chat**. All of it is read only. Terminal is the agent's live herdr terminal: click
  it and every key goes in, Esc too; `Ctrl+`` ` opens it and goes back to the chat. Files lists the worktree (tracked
  files and new ones git doesn't ignore), finds one by name and shows it highlighted. Diff shows what the task changed
  against where it left main, committed or not: its files as a tree with lines added and taken out, and each file's
  unified diff. Pull request shows the task's PR on GitHub (state, checks, a link), asked of `gh` on the remote's own
  host; greyed out until one is open. The server reads only that worktree: a file is read only when git lists it
  there and it really lies inside it (no `..`, no links out, nothing ignored, never `.git`). Coordinator chats have no
  panel; their terminal flips the chat, from the ⋯ menu or `Ctrl+`` `.

Every agent learns the chat lines, cards, artifacts and the `shepherdr` command from
[skill/shepherdr](../skill/shepherdr/SKILL.md); coordinators their tasks, news, merges and Autopilot from
[skill/shepherdr-coordinator](../skill/shepherdr-coordinator/SKILL.md); task agents the way from brief to merged from
[skill/shepherdr-agent](../skill/shepherdr-agent/SKILL.md). Their prompts (`server/live/prompts.ts`) say only who they are,
their space (and a home space's machine duties) or task, and which skills to read. `shepherdr help` lists the command.
