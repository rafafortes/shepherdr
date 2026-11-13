// What each agent is told when Shepherdr starts it: its role, where the skills are, and how to report back. And the
// Settings block Shepherdr adds to the end of every new task's brief.
import { join } from 'node:path'
import { OLD_HEADS, SET_BY, SETTINGS_HEAD, type SetBy } from '../../shared/brief.ts'
import { type Mode } from '../../shared/types.ts'
import { ROOT } from '../root.ts'
import { has } from '../plugins.ts'
import { BOX, helperDir } from './box.ts'

/** where an agent finds Shepherdr's files: its checkout here; on another machine the helper's copy (install.ts) */
const OWN = BOX ? helperDir(BOX.home) : ROOT

/** Shepherdr's skills, each in <name>/SKILL.md: shepherdr (every agent), shepherdr-coordinator (coordinators) and
 *  shepherdr-agent (task agents) */
export const SKILLS = join(OWN, 'skill')
const skill = (name: string) => join(SKILLS, name, 'SKILL.md')

/** how a command is written where its path has a space: as a shell needs it, and as the hook allows it */
const quoted = (path: string) => (path.includes(' ') ? `"${path}"` : path)

export const commandLine = (chat: string) => `Your authoritative command is SHEPHERDR_CHAT=${JSON.stringify(chat)} ${quoted(join(OWN, 'bin', 'shepherdr'))}.${BOX ? '' : ` Write it out in full each time, as this line does, rather than the bare name shepherdr or $SHEPHERDR_COMMAND: only that form runs without a permission prompt, and a line with anything after the command still asks.`} Use it if a shell finds another shepherdr. Never start a server to repair command routing. For a deliberately targeted dev/demo server, use the repo command with --url <URL>.`

const base = (who: string, own: string) =>
  `You are ${who}, running inside Shepherdr (a herdr plugin the human uses from a phone, tablet or desktop). Read ${skill('shepherdr')} first (chat lines, cards, artifacts, the shepherdr command), then ${skill(own)} (your role's work). The human reads your replies in a calm chat: keep them short, plain and to the point.`

/** the How tasks work settings, as a brief's Settings block says them */
export interface Ways {
  /** the brief asks for a fresh-eyes review before it merges; how is the task agent's own call */
  review: boolean
  /** the least severity a finding needs to be fixed (SEVERITIES), and how many rounds of review at most */
  mustFix: string
  rounds: number
  merge: string
  /** shepherdr merge waits for GitHub's checks on the pull request; else the task's own quick checks are enough */
  waitChecks: boolean
}

/** the CLI, model and effort the brief suggests for its review; nothing for a CLI's own default */
export interface Reviewer {
  kind: string
  model?: string
  effort?: string
}

const REVIEWER_NAME: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', pi: 'pi' }

/** "a headless Codex or a Codex subagent (its default model and effort)", "… Claude Code … (model opus, high effort)" */
export function reviewerWords(r: Reviewer) {
  const name = REVIEWER_NAME[r.kind] ?? r.kind
  const who = `a headless ${name} or a ${name} subagent`
  if (!r.model && !r.effort) return `${who} (its default model and effort)`
  return `${who} (${[r.model ? `model ${r.model}` : 'its default model', r.effort ? `${r.effort} effort` : 'its default effort'].join(', ')})`
}

/** a brief's Reviewer line: who reviews, and how a round asks which reviewer it runs with (`shepherdr review <id>`, which
 *  counts the round and names the reviewer the caps leave; `--done` when its review has finished). When the human set
 *  backup reviewers, the line also says who reviews instead where the one named cannot run at all, for that round only:
 *  a backup never replaces a finding, and every round asks the command again, so a primary that answers again reviews the
 *  next round */
export function reviewerLine(r: Reviewer, backup: Reviewer | Reviewer[] | undefined, id: string) {
  const all = backup === undefined ? [] : Array.isArray(backup) ? backup : [backup]
  const ask = `Each round, run \`shepherdr review ${id}\` first: it names the reviewer for that round and the words to pass. After the review, run \`shepherdr review ${id} --done\`.`
  if (!all.length) return `Reviewer: ${reviewerWords(r)}. ${ask}`
  // a chain of them: each in turn, where the one before it cannot run either
  const rest = all.length > 1 ? `; where that one cannot run either, the next of, in turn: ${all.slice(1).map(reviewerWords).join('; ')}` : ''
  return `Reviewer: ${reviewerWords(r)}. ${ask} If that reviewer cannot run at all (out of allowance, signed out, its model is gone), review with ${reviewerWords(all[0])} instead for that round only${rest}, and say in your summary that you did.`
}

/** a reviewer's tags for its findings, the worst first */
export const SEVERITIES = ['critical', 'major', 'minor', 'trivial']

/** the Settings block's lines, by the settings each comes from (Settings → How tasks work shows each under its row) */
export type Said = 'review' | 'reviewer' | 'mustFix' | 'rounds' | 'merge' | 'agent'

/** what a brief's Settings block says: How tasks work, who reviews (and who does where that one cannot run at all), the
 *  agent it runs on (only so it knows), and who set the lines that differ from Shepherdr's own */
export interface Told {
  ways: Ways
  reviewer?: Reviewer
  /** the backup reviewer (or its chain, in turn), when the human set one: nothing, and the Reviewer line reads as it
   *  always has */
  fallback?: Reviewer | Reviewer[]
  agent?: Reviewer
  by?: Partial<Record<Said, SetBy>>
}

const plural = (xs: string[]) => (xs.length === 1 ? xs[0] : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`)

/** "Claude Code (its default model and effort)", "Codex (model gpt-5.5, high effort)" */
function onWords(r: Reviewer) {
  const name = REVIEWER_NAME[r.kind] ?? r.kind
  if (!r.model && !r.effort) return `${name} (its default model and effort)`
  return `${name} (${[r.model ? `model ${r.model}` : 'its default model', r.effort ? `${r.effort} effort` : 'its default effort'].join(', ')})`
}

/** the Settings block's lines, each with what it comes from: plain words, each with its value first */
export function settingsLines(id: string, t: Told): { said: Said; text: string }[] {
  const w = t.ways
  const fix = SEVERITIES.slice(0, Math.max(1, SEVERITIES.indexOf(w.mustFix) + 1))
  const merge =
    w.merge === 'ask me first'
      ? `ask me first. Ask the human first, and merge (shepherdr merge ${id}) once they say yes.`
      : w.waitChecks
        ? `after GitHub checks. Merge it yourself once it works and GitHub's checks pass (shepherdr checks ${id}, then shepherdr merge ${id}).`
        : `on its own. Merge it yourself once it works (shepherdr merge ${id}). Don't wait for GitHub's checks.`
  // every line shows, review off too: nothing hidden, an override included
  const lines: { said: Said; text: string }[] = [
    { said: 'review', text: w.review ? 'Review: on. Have your change reviewed by fresh eyes before it merges.' : "Review: off. No review; the lines on reviewing below don't apply." },
    ...(t.reviewer ? [{ said: 'reviewer' as const, text: reviewerLine(t.reviewer, w.review ? t.fallback : undefined, id) }] : []),
    { said: 'mustFix', text: `Must fix: ${w.mustFix}. Findings are tagged ${SEVERITIES.join('/')}; fix ${fix.length === SEVERITIES.length ? 'all of them' : plural(fix)}${w.rounds > 1 ? ', then review again' : ''}.` },
    { said: 'rounds', text: w.rounds > 1 ? `Review rounds: ${w.rounds}. Stop when a round finds none to fix, at most ${w.rounds} rounds.` : 'Review rounds: 1. One round, no review again.' },
  ]
  lines.push({ said: 'merge', text: `Merge: ${merge}` })
  if (t.agent) lines.push({ said: 'agent', text: `Agent: ${onWords(t.agent)}. Only so you know what you run on.` })
  return lines.map((l) => ({ ...l, text: marked(l.text, t.by?.[l.said]) }))
}

/** a block line's text, with who set it where it differs from Shepherdr's own default */
const marked = (text: string, by?: SetBy) => (by ? `${text} (${SET_BY[by]})` : text)

/** where a brief's Settings block starts (the head of the kind it has, as splitBrief reads it); -1 when there is none */
function blockAt(desc: string) {
  return [SETTINGS_HEAD, ...OLD_HEADS].map((h) => desc.lastIndexOf(h)).find((x) => x >= 0) ?? -1
}

/** a brief split into the coordinator's words and the Settings block Shepherdr ended it with (empty when it has none) */
export function splitBrief(desc: string): [work: string, how: string] {
  const i = blockAt(desc)
  return i < 0 ? [desc, ''] : [desc.slice(0, i).trimEnd(), desc.slice(i)]
}

/**
 * A brief with its Settings block's Reviewer line said again, for a reviewer Settings changed: who reviews now, the
 * backup reviewers too where the block says Review is on (its own Review line; `review`, when it has none), and who set
 * it. The words above the block and every other line of it stay byte for byte. A brief with no block, or with no
 * Reviewer line in it, comes back as it is.
 */
export function rebriefReviewer(desc: string, r: { id: string; reviewer: Reviewer; fallback?: Reviewer | Reviewer[]; review: boolean; by?: SetBy }): string {
  const i = blockAt(desc)
  if (i < 0) return desc
  const lines = desc.slice(i).split('\n')
  const n = blockEnd(lines)
  const k = lines.findIndex((l, j) => j > 0 && j < n && l.startsWith('- Reviewer: '))
  if (k < 0) return desc
  const review = briefReview(desc) ?? r.review
  lines[k] = `- ${marked(reviewerLine(r.reviewer, review ? r.fallback : undefined, r.id), r.by)}`
  return desc.slice(0, i) + lines.join('\n')
}

/** the number of lines of a block read from its head (lines[0]): its "- " lines, as readBrief reads them */
function blockEnd(lines: string[]) {
  const end = lines.findIndex((l, j) => j > 0 && !l.startsWith('- '))
  return end < 0 ? lines.length : end
}

/** whether a brief's Settings block says Review is on (true) or off (false); undefined when the brief has no such line */
export function briefReview(desc: string): boolean | undefined {
  const i = blockAt(desc)
  if (i < 0) return undefined
  const lines = desc.slice(i).split('\n')
  const line = lines.slice(1, blockEnd(lines)).find((l) => l.startsWith('- Review: '))
  return line === undefined ? undefined : line.startsWith('- Review: on.')
}

/** the line a waiting task's agent hears with its go when its reviewer changed while it waited: its brief was read
 *  before, so this says what the brief's Settings block says now */
export function reviewerChangedLine(line: string) {
  return `Your reviewer changed while you waited; your brief's Settings block now says: "${line}" Review with that reviewer from now on.`
}

/**
 * The Settings block that ends every new task's brief: the human's defaults from Settings, one line each, each marked
 * where it differs from Shepherdr's own and by whom; nothing on how to do the work. The coordinator's words come first
 * and win where they differ, so a wish for one task needs no setting changed.
 */
export function settingsBlock(id: string, t: Told) {
  return `${SETTINGS_HEAD}\n${settingsLines(id, t).map((l) => `- ${l.text}`).join('\n')}`
}

/** a space's coordinator: its space's work; a home space's also its machine's (health, load and disk news, its
 *  processes, adding spaces); the main machine's home space's also every machine's overview (what needs the human,
 *  which alerts reach the phone, machine-wide alerts), as it can see every machine */
export function coordinatorPrompt(place: { role: 'space' | 'home' | 'main'; name: string; path?: string; machine: string; chat?: string }, mode: Mode) {
  const who = `the coordinator of the space ${place.name} on ${place.machine} (${place.path})`
  const duties =
    place.role === 'space'
      ? ''
      : place.role === 'home'
        ? `\n\nThis is ${place.machine}'s home space: you also look after the machine (its health, load and disk news, its processes) and add spaces on it when asked (shepherdr space add).`
        : `\n\nThis is the home space of the main machine, ${place.machine}: you also look after this machine (its health, load and disk news, its processes, adding spaces with shepherdr space add), and you keep the overview of every machine: what needs the human across them all (shepherdr task list shows every machine's tasks), which alerts reach the phone, and machine-wide alerts.`
  return `${base(who, 'shepherdr-coordinator')}\n\n${commandLine(place.chat ?? place.name)}${duties}

Autopilot is ${mode === 'autopilot' ? 'on' : 'off'} now. On Autopilot you get a heartbeat while idle, on its trigger: shepherdr heartbeat shows your HEARTBEAT.md and when, shepherdr heartbeat set changes it.`
}

export function taskPrompt(t: { id: string; branch: string; base: string }, times = '') {
  return [
    base(`the agent of task ${t.id}`, 'shepherdr-agent'),
    commandLine(`${t.id}/Agent`),
    `You work in your own git worktree on branch ${t.branch} (from ${t.base}): commit there, and don't switch branches.`,
    times,
    has('browser') ? browserLine(t.id) : '',
  ].filter(Boolean).join('\n\n')
}

/** the shared browser, in a task's instructions (the skill says more) */
const browserLine = (id: string) => {
  // by its full path: a shell's start-up files can put another agent-browser ahead of Shepherdr's bin on the PATH, and
  // two versions on one session keep restarting its daemon
  const ab = join(OWN, 'bin', 'agent-browser')
  return `Your shared browser (session ${id}, set in your environment) runs only by its full path, ${ab}: a plain agent-browser may be another version, and two versions on one session keep restarting it.`
}

export function taskFirst(t: { title: string; desc: string }) {
  return t.desc && t.desc !== t.title ? `${t.title}\n\n${t.desc}` : t.title
}

/** what a start is told when the session it was to resume is gone: a new one remembers none of it */
/** what came into a task's base since its branch began, as Shepherdr found it before its agent went back to work */
export type BaseMoved = { base: string; commits: string[]; rules: string[]; state: 'rebased' | 'conflict' | 'dirty'; gate?: boolean }

/** what a task's agent is told when its base moved while it was away: rebased for it, or what to do at a good point */
export function baseMovedLine(m: BaseMoved) {
  const n = m.commits.length
  const came = `${n} commit${n === 1 ? '' : 's'} came into ${m.base} since your branch began (${m.commits.slice(0, 5).join('; ')}${n > 5 ? '; …' : ''})`
  const rules = m.rules.length ? ` ${m.rules.join(' and ')} changed among them: read ${m.rules.length === 1 ? 'it' : 'them'} again before you go on.` : ''
  // a space with a merge gate runs its full check at the merge: an agent proves its own change, never the whole again
  const checks = m.gate ? 'test what you changed (the merge gate runs the full check when you merge)' : 'run the checks'
  if (m.state === 'rebased') return `Before you went back to work, Shepherdr rebased your branch on ${m.base}: ${came}.${rules} What you build on moved, so ${m.gate ? 'test what you changed again; the merge gate runs the full check when you merge' : 'run the checks again before you report done'}.`
  if (m.state === 'conflict') return `${came}. Rebasing your branch on it conflicts, so Shepherdr left your worktree as it was: at your next good point, rebase on ${m.base} (git rebase ${m.base}), resolve the conflicts and ${checks}.${rules}`
  return `${came}. Your worktree has changes not committed, so Shepherdr didn't rebase it: at your next good point, commit, rebase on ${m.base} (git rebase ${m.base}) and ${checks}.${rules}`
}

/** the card a task's chat gets for it */
export function baseMovedCard(m: BaseMoved) {
  const n = `${m.commits.length} new commit${m.commits.length === 1 ? '' : 's'} in ${m.base}`
  return m.state === 'rebased' ? `Rebased on ${m.base}: ${n}` : `Not rebased (${m.state === 'conflict' ? 'it conflicts' : 'changes not committed'}): ${n}; its agent rebases at a good point`
}

export function freshLine() {
  return 'Your earlier session is gone, so this is a new one that remembers none of it. What was done is on the branch and in this chat: look at what is here before you start, and keep the work that is already done.'
}

/** what a backup agent is told after the brief when it takes a task over: from whom and why, and what was done */
export function handOverLine(o: { from: string; why: string; commits: string; changes: string; chat: string }) {
  return [
    `Taking over: ${o.from} worked on this task until now and can't go on (${o.why}). You carry on in the same worktree and branch: look at what is there and go on from it, don't start over.`,
    `Commits on the branch so far:\n${o.commits || 'none'}`,
    `Uncommitted changes:\n${o.changes || 'none'}`,
    ...(o.chat ? [`The chat so far, latest last:\n\n${o.chat}`] : []),
  ].join('\n\n')
}

/** what a coordinator's backup agent is told when it takes the chat over on another CLI: who ran it until now, why it
 *  stopped, its open tasks and the chat so far */
export function coordinatorHandOverLine(o: { from: string; why: string; tasks: string[]; chat: string }) {
  return [
    `Taking over: ${o.from} ran this chat's coordinator until now and can't go on (${o.why}). You are its coordinator now, in the same folder: its tasks go on as they are and its settings are as they were. Look at what is there and go on from it, don't start over.`,
    ...(o.tasks.length ? [`Its tasks that are not done:\n${o.tasks.join('\n')}`] : []),
    ...(o.chat ? [`The chat so far, latest last:\n\n${o.chat}`] : []),
  ].join('\n\n')
}

/** what an agent is told when the backup is its own CLI started again: the provider cut it off, and its session is as
 *  it was (maybe on another model) */
export function backupKeptLine(o: { on: string; why: string }) {
  return `Your turn was cut off by the model's provider (${o.why}). Shepherdr started you again on ${o.on}, with your session as it was: carry on where you left off. If there is nothing left to do, reply with only <no-reply>backup</no-reply>.`
}

/** the words a chat's card says a backup went in: another CLI took over, or the same CLI started again with its session */
export function backupCardWords(o: { from: string; to: string; words: string; same: boolean; why: string }) {
  return o.same ? `${o.words} started again, with its session: ${o.why}` : `${o.to} took over from ${o.from}: ${o.why}`
}

/** the words a chat's card says its agent went back by itself to its primary model, which answers again (return.ts),
 *  or started again on the model that had cut it off */
export function wentBackCardWords(words: string, back: BackWhy = 'backup') {
  if (back === 'room') return `Back on ${words}: its model has room under its cap now`
  return back === 'again' ? `Started again on ${words}: its provider answers again` : `Back on the primary model, which answers again: ${words}`
}

/** what an agent started again on another CLI is told (a task's after its brief): who ran its role until now, and
 *  what was said and done; a task's commits and changes, none for a coordinator. back: Shepherdr took it back to its
 *  primary model, which answers again, from the backup that ran it (return.ts), not the human */
export function restartLine(o: { from: string; to: string; chat: string; commits?: string; changes?: string; back?: boolean; room?: boolean }) {
  const task = o.commits !== undefined
  const why = o.room ? ', which has room under its cap now' : ', which answers again'
  const who = o.back ? `Shepherdr moved this ${task ? 'task' : 'chat'} back to its primary model${why}: ${o.to}. ${o.from}, its backup,` : `the human restarted this ${task ? 'task' : 'chat'} on ${o.to}. ${o.from}`
  return [
    `Restarted: ${who} ran it until now; you carry on from here, in the same ${task ? 'worktree and branch' : 'folder'}. Look at what is there and go on from it, don't start over.`,
    ...(task ? [`Commits on the branch so far:\n${o.commits || 'none'}`, `Uncommitted changes:\n${o.changes || 'none'}`] : []),
    ...(o.chat ? [`The chat so far, latest last:\n\n${o.chat}`] : []),
    `If you were in the middle of something, carry on; else reply in one short line that you are here and end your turn.`,
  ].join('\n\n')
}

/** what an agent Shepherdr started again by itself is told, when it was at work as it stopped */
export function relaunchedLine() {
  return `Your agent had stopped (herdr restarted, or it ran on outdated settings): Shepherdr started you again, with your session as it was. Carry on where you left off; if there is nothing left to do, reply with only <no-reply>relaunched</no-reply>.`
}

/** why Shepherdr, not the human, started an agent again (return.ts): back from its backup to the primary model, which
 *  answers again; or again on the model that cut it off, whose provider answers again */
export type BackWhy = 'backup' | 'again' | 'room'

/** what an agent started again on its own CLI is told, its session resumed (a model or an effort changed). back: it was
 *  Shepherdr, once the primary answered again (return.ts), not the human */
export function resumedLine(on: string, back?: BackWhy) {
  if (back === 'backup') return `The primary model answers again, so Shepherdr moved you back to it from your backup: ${on}, with your session as it was. If you were in the middle of something, carry on where you left off; else reply with only <no-reply>back</no-reply>.`
  if (back === 'room') return `Your primary model has room under its cap again, so Shepherdr moved you back to it from the backup you started on: ${on}, with your session as it was. If you were in the middle of something, carry on where you left off; else reply with only <no-reply>back</no-reply>.`
  if (back === 'again') return `Your model's provider cut your turn off, and it answers again: Shepherdr started you again on ${on}, with your session as it was. Carry on where you left off; if there is nothing left to do, reply with only <no-reply>back</no-reply>.`
  return `The human restarted you on ${on}, with your session as it was. If you were in the middle of something, carry on where you left off; else reply with only <no-reply>restarted</no-reply>.`
}

/** what a task queued after others is told: with its brief (start), when queued while it runs (later), or when what
 *  it waits for changed */
export function queuedLine(ids: string[], when: 'start' | 'later' | 'changed', id = '<id>') {
  const them = ids.length === 1 ? 'it is' : 'they are'
  const rest = `Shepherdr tells you "Go: … start now." once ${them} done. A message from the human or the coordinator may be a go too: if it is, run shepherdr task queue ${id} --after none and start.`
  if (when === 'changed') return `You now wait for ${ids.join(', ')} instead. Don't start yet. ${rest}`
  if (when === 'later') return `Hold on: you are now queued after ${ids.join(', ')}. Stop at a clean point and don't go on with the work: reply in one line that you wait, and end your turn. ${rest}`
  return `Queued: this task waits for ${ids.join(', ')} to be done. Don't start the work yet: reply in one line that you have the brief, and end your turn. ${rest}`
}

/** the go a queued task gets: what it waited for is done (and what each said), or it waits for them no more */
export function goLine(ids: string[], notes: string[], cleared = false) {
  if (cleared) return `Go: you no longer wait for ${ids.join(', ')}, start now.`
  return [`Go: ${ids.join(', ')} ${ids.length === 1 ? 'is' : 'are'} done, start now.`, ...notes].join('\n')
}

/** news from GitHub on a done task's pull request, as its agent hears it: what happened, never what to do about it */
export function prNewsLine(id: string, pr: { number: number; url: string }, news: string[]) {
  return [`GitHub news on PR #${pr.number} (${pr.url}), since you reported ${id} ready:`, ...news, 'The shepherdr-agent skill says how to handle news like this.'].join('\n')
}

/** Personal settings are supplemental, never a replacement for repository rules or a human's explicit request. */
export function privatePrompt(own: string, reviewer?: string): string {
  return [
    'Private instruction snapshot for this start. This replaces earlier private instruction snapshots, including when empty. Read and follow the repository/team AGENTS.md, CLAUDE.md and REVIEW.md alongside these supplemental rules. Never edit, replace or create repository instruction files to install these rules. Explicit human instructions and the task brief win over private rules; if private and team rules conflict, explain and ask rather than silently overriding either. Never copy private instructions into git, briefs, reports or GitHub. These fields are not a secret store.',
    own,
    ...(reviewer === undefined ? [] : [
      'Reviewer handoff only: the next block applies to reviewers, not to you as the task agent. Include this reviewer block and the precedence/privacy rules above in every fresh reviewer prompt (headless or subagent), alongside the brief and repository rules. This is the snapshot from your latest start; restart this task agent to refresh it after Settings changes. Do not pass your task-only private rules to reviewers.',
      reviewer,
    ]),
  ].join('\n\n')
}
