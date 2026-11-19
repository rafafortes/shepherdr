// Change a running agent's model and effort in place, on the same CLI and the same session (SHE-45, the port of
// upstream SHEP-181 / 45d7e850): no restart, no stopped turn, no touched worktree or branch. Where the CLI has no
// mid-session switch (OpenCode, agy), liveOK is false and the caller keeps the restart path.
//
// A switch is only believed when the agent's own chat says so: `io.chat()` reads its log through that CLI's reader,
// the same path the chat window uses (readers/index.ts, chats.ts, runtime.ts). Nothing here trusts a write or a screen
// echo as proof. If a step fails after an earlier one took, every field that did take is put back to what it started
// on and verified the same way, so a half-applied switch is never left behind.
//
// Checked on this host (2026-11-16): Claude Code `/model` and `/effort` (its local-command-stdout log lines) and pi's
// built-in `/model <provider/model>` and `/thinking <level>` (pi 1.5.2's slash-commands list). Codex is NOT installed
// here (removed 2026-10-15): its `/model` picker and `thread_settings_applied` line come from upstream's Codex 0.163
// (45d7e850) and are covered with a fake screen/log, not a local run. `opencode --help` and `agy --help` offer
// with no in-session switch whose result their chat log reports before the next reply (their own /models and /model
// exist), so those two keep the restart.

/** CLIs with a mid-session model/effort switch. */
export const LIVE_KINDS = ['claude', 'codex', 'pi'] as const

/** A CLI, model and effort as compared (ids and concrete levels, '' for the CLI's own). */
export interface SwitchTarget {
  kind: string
  model?: string
  effort?: string
}

/** What the chat window reads out of the CLI's log for this launch. */
export interface ChatState {
  model?: string
  effort?: string
}

/** Where a switch runs: typed into the agent's pane, awaited on its chat. */
export interface SwitchIO {
  send(text: string): Promise<void>
  keys(...keys: string[]): Promise<void>
  screen(): Promise<string>
  chat(): Promise<ChatState>
  sleep(ms: number): Promise<void>
  /** files in the agent's home, for the defaults a CLI saves as a side effect of its command */
  readFile?(rel: string): Promise<string | null>
  writeFile?(rel: string, text: string): Promise<void>
}

/** A typed command and the concrete value its answer in the chat must say. */
export interface Step {
  text: string
  field: 'model' | 'effort'
  want: string
  fail?: RegExp
}

/** Claude Code saves a /model or /effort as the default for NEW sessions too; put back only the keys it touched. */
export const CLAUDE_SETTINGS = '.claude/settings.json'
const CLAUDE_KEYS = ['model', 'effortLevel', 'fastMode', 'modelSettings']

export function claudeRestore(before: string | null, now: string | null): string | null {
  let b: Record<string, unknown>, n: Record<string, unknown>
  try {
    b = JSON.parse(before || '{}')
    n = JSON.parse(now || '{}')
  } catch {
    return null
  }
  if (!b || !n || typeof b !== 'object' || typeof n !== 'object') return null
  let changed = false
  for (const k of CLAUDE_KEYS) {
    if (JSON.stringify(b[k]) === JSON.stringify(n[k])) continue
    changed = true
    if (k in b) n[k] = b[k]
    else delete n[k]
  }
  return changed ? JSON.stringify(n, null, 2) + (String(now).endsWith('\n') ? '\n' : '') : null
}

export function liveOK(kind: string): boolean {
  return (LIVE_KINDS as readonly string[]).includes(kind)
}

/** What differs; a new model always restates its level, because CLIs keep a level per model. */
export function liveChanges(from: SwitchTarget, to: SwitchTarget): { model?: string; effort?: string } {
  const out: { model?: string; effort?: string } = {}
  const model = to.model ?? ''
  const effort = to.effort ?? ''
  if (model !== (from.model ?? '')) out.model = model
  if (out.model !== undefined || effort !== (from.effort ?? '')) out.effort = effort
  return out
}

/** Claude Code's commands, in order. Every value is concrete: an unnamed default cannot be read back from the chat. */
export function claudeSteps(ch: { model?: string; effort?: string }): Step[] {
  const out: Step[] = []
  if (ch.model !== undefined) out.push({ text: `/model ${ch.model}`, field: 'model', want: ch.model, fail: /Model .*not found|Invalid model|isn't available/i })
  if (ch.effort !== undefined) out.push({ text: `/effort ${ch.effort}`, field: 'effort', want: ch.effort, fail: /Invalid (?:effort|argument)/i })
  return out
}

/** pi's commands. Its equivalent of effort is the thinking level; both take an explicit value. */
export function piSteps(ch: { model?: string; effort?: string }): Step[] {
  const out: Step[] = []
  if (ch.model !== undefined) out.push({ text: `/model ${ch.model}`, field: 'model', want: ch.model, fail: /not found|invalid model/i })
  if (ch.effort !== undefined) out.push({ text: `/thinking ${ch.effort}`, field: 'effort', want: ch.effort, fail: /invalid|unknown/i })
  return out
}

/** The screen's text after the newest line that echoes `text` as typed: only that is this command's own answer. */
export function after(screen: string, text: string): string | null {
  const lines = screen.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.replace(/^[\s❯>›»]+/, '').trimEnd() === text) return lines.slice(i + 1).join('\n')
  }
  return null
}

/** A command went in: its own answer in the chat is the proof, never the fact that it was typed, and never an old
 *  line of scrollback that happens to say "not found" (a pane carries hundreds of lines of unrelated tool output). */
async function awaitStep(io: SwitchIO, step: Step): Promise<void> {
  await io.send(step.text)
  let asked = false
  for (let t = 0; t < 8000; t += 250) {
    const answer = after(await io.screen(), step.text)
    if (answer !== null) {
      const bad = step.fail ? step.fail.exec(answer) : null
      if (bad) throw new Error(bad[0].trim())
      // Claude Code asks before switching a model whose conversation is cached: Yes is the first choice
      if (!asked && /Switch model\?/.test(answer) && /❯\s*1\.\s*Yes/.test(answer)) {
        asked = true
        await io.keys('enter')
      }
    }
    const chat = await io.chat()
    if (chat[step.field] === step.want) return
    await io.sleep(250)
  }
  throw new Error(`${step.text.split(' ')[0]} didn't take: the chat didn't report ${step.want}.`)
}

/** Wait until the chat reports the whole target at once (a model switch can also move the level). */
async function awaitChat(io: SwitchIO, want: ChatState): Promise<boolean> {
  for (let t = 0; t < 8000; t += 250) {
    const chat = await io.chat()
    if ((!want.model || chat.model === want.model) && (!want.effort || chat.effort === want.effort)) return true
    await io.sleep(250)
  }
  return false
}

/** The command that puts one field back where it started, or nothing when the old value is not concrete. */
function undo(step: Step, from: SwitchTarget): Step | undefined {
  const old = from[step.field] ?? ''
  if (!old) return undefined
  return { ...step, text: `${step.text.split(' ')[0]} ${old}`, want: old }
}

/** Typed commands with a rollback: every field is restored, even one a model switch moved on its own. */
async function typed(io: SwitchIO, steps: Step[], from: SwitchTarget): Promise<void> {
  try {
    for (const step of steps) {
      // a command that was typed may have taken effect even when its answer never came: it must be undone
      await awaitStep(io, step)
    }
  } catch (e) {
    const back = steps.map((s) => undo(s, from)).filter((s): s is Step => !!s)
    const failed: string[] = []
    for (const step of back) {
      try {
        await awaitStep(io, step)
      } catch {
        failed.push(step.field)
      }
    }
    // restoring the level matters even when this switch never typed a level command: changing a model can reset it
    if (!failed.length && !(await awaitChat(io, { model: from.model, effort: from.effort }))) failed.push('model and effort')
    throw new Error(failed.length ? `${(e as Error).message} It could not be put back on ${failed.join(' and ')}.` : (e as Error).message)
  }
}

/** Claude Code saves the pick as the default for new sessions too: read its settings, then put the touched keys back. */
async function withClaudeDefaults(io: SwitchIO, run: () => Promise<void>) {
  const read = io.readFile?.bind(io)
  const write = io.writeFile?.bind(io)
  const before = read ? await read(CLAUDE_SETTINGS).catch(() => null) : null
  try {
    await run()
  } finally {
    if (before !== null) {
      // the save lands with the command's answer; a moment more, then only the keys it touched go back
      await io.sleep(300)
      const now = await read!(CLAUDE_SETTINGS).catch(() => null)
      const back = now == null ? null : claudeRestore(before, now)
      if (back !== null) await write?.(CLAUDE_SETTINGS, back)
    }
  }
}

/* ---------- Codex's /model picker (model, then level; `s` applies to this session only) ---------- */

export interface CodexRow {
  n: number
  label: string
  sel: boolean
  current: boolean
  dflt: boolean
}

/** The numbered rows of the newest picker on screen. */
export function codexRows(screen: string): CodexRow[] {
  const lines = screen.split('\n')
  let start = -1
  for (let i = lines.length - 1; i >= 0; i--)
    if (/^\s*(Select Model|Select Reasoning|Advanced Reasoning)/.test(lines[i]!)) {
      start = i
      break
    }
  if (start < 0) return []
  const rows: CodexRow[] = []
  for (const line of lines.slice(start + 1)) {
    const m = /^\s*(›)?\s*(\d+)\.\s+(.+?)(?:\s{2,}.*)?$/.exec(line)
    if (!m) continue
    const words = m[3]!
    rows.push({ n: Number(m[2]), sel: !!m[1], label: words.replace(/\s*\((?:current|default)\)/g, '').trim(), current: /\(current\)/.test(words), dflt: /\(default\)/.test(words) })
  }
  return rows
}

/** Which picker is up: its model list, its levels, the deeper levels, or none. */
export function codexPicker(screen: string): 'model' | 'effort' | 'more' | null {
  const lines = screen.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*Select Model/.test(lines[i]!)) return 'model'
    if (/^\s*Select Reasoning/.test(lines[i]!)) return 'effort'
    if (/^\s*Advanced Reasoning/.test(lines[i]!)) return 'more'
    if (/^\s*›\s*Ask Codex|^\s*[›»]\s*$/.test(lines[i]!)) return null
  }
  return null
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
const LEVEL: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' }

/** The model row by its id or the label Codex shows; the marked default when no id is named. */
export function codexModelRow(rows: CodexRow[], id?: string, label?: string): CodexRow | null {
  if (!id) return rows.find((r) => r.dflt || r.current) ?? null
  const want = [id, label].filter(Boolean).map((v) => squash(v!))
  return rows.find((r) => want.includes(squash(r.label))) ?? null
}

/** The level row, '' for the model's default; 'more' when it sits behind More reasoning. */
export function codexEffortRow(rows: CodexRow[], effort: string): CodexRow | 'more' | null {
  if (!effort) return rows.find((r) => r.dflt) ?? null
  const name = squash(LEVEL[effort] ?? effort)
  return rows.find((r) => squash(r.label) === name) ?? (rows.find((r) => /^More reasoning/i.test(r.label)) ? 'more' : null)
}

/** The keys that move a picker's highlight from where it is to row n. */
export function moveTo(rows: CodexRow[], n: number): string[] {
  const at = rows.find((r) => r.sel)?.n ?? rows[0]?.n ?? n
  return Array(Math.abs(n - at)).fill(n > at ? 'down' : 'up')
}

const CHANGED = /^\s*•\s*Model changed to /

/** navigate a picker to a row, choose it, and let the screen settle */
async function pick(io: SwitchIO, rows: CodexRow[], n: number, key: 'enter' | 's') {
  for (const k of moveTo(rows, n)) await io.keys(k)
  await io.sleep(150)
  await io.keys(key)
}

/** wait for the screen to show one of these picker states */
async function screenFor(io: SwitchIO, test: (s: string) => boolean): Promise<string> {
  let s = await io.screen()
  for (let t = 0; t < 8000 && !test(s); t += 250) {
    await io.sleep(250)
    s = await io.screen()
  }
  return s
}

async function codexSwitch(io: SwitchIO, from: SwitchTarget, to: SwitchTarget, names: Record<string, string>) {
  const ch = liveChanges(from, to)
  const apply = async (model: string, effort: string) => {
    const was = count(await io.screen(), CHANGED)
    await io.send('/model')
    const s = await screenFor(io, (x) => codexPicker(x) === 'model')
    if (codexPicker(s) !== 'model') throw new Error("Codex didn't open its model list.")
    const rows = codexRows(s)
    const row = codexModelRow(rows, model, names[model])
    if (!row) {
      await io.keys('esc')
      throw new Error(`${names[model] ?? (model || 'That model')} isn't in Codex's list.`)
    }
    await pick(io, rows, row.n, 'enter')
    const level = await screenFor(io, (x) => codexPicker(x) === 'effort' || count(x, CHANGED) > was)
    if (codexPicker(level) === 'effort') {
      let rows = codexRows(level)
      let r = codexEffortRow(rows, effort)
      if (r === 'more') {
        await pick(io, rows, rows.find((x) => /^More reasoning/i.test(x.label))!.n, 'enter')
        const deeper = await screenFor(io, (x) => codexPicker(x) === 'more')
        rows = codexRows(deeper)
        r = codexEffortRow(rows, effort)
      }
      if (!r || r === 'more') {
        await io.keys('esc', 'esc', 'esc')
        throw new Error(`Codex doesn't offer ${LEVEL[effort] ?? effort} for that model.`)
      }
      // `s` applies to this session only (Enter would save it as the default too)
      await pick(io, rows, r.n, 's')
    }
    for (let t = 0; t < 8000; t += 250) {
      const c = await io.chat()
      if ((!model || c.model === model) && (!effort || c.effort === effort)) return
      await io.sleep(250)
    }
    throw new Error("Codex didn't confirm the change.")
  }
  try {
    await apply(ch.model ?? from.model ?? '', ch.effort ?? from.effort ?? '')
  } catch (e) {
    // put back both fields we set: a half-applied Codex switch is never left behind
    try {
      await apply(from.model ?? '', from.effort ?? '')
    } catch {
      throw new Error(`${(e as Error).message} It could not be put back.`)
    }
    throw e
  }
}

function count(screen: string, re: RegExp) {
  return screen.split('\n').filter((l) => re.test(l)).length
}

/** Switch in place, or report why not; a failed switch is rolled back and verified before this throws. */
export async function switchLive(io: SwitchIO, kind: string, from: SwitchTarget, to: SwitchTarget, names: Record<string, string> = {}): Promise<{ model?: string; effort?: string }> {
  const ch = liveChanges(from, to)
  if (!Object.keys(ch).length) return ch
  if (!liveOK(kind)) throw new Error(`${kind} has no in-session model switch.`)
  // a CLI's own default is not a value its chat reports: the caller resolves both sides to concrete ids/levels, or
  // restarts. Without a concrete starting value there is no honest way to put a failed switch back.
  if ((ch.model === '' && !!from.model) || (ch.effort === '' && !!from.effort)) throw new Error("A switch back to the CLI's own default can't be read back from its chat; use Restart.")
  if ((ch.model !== undefined && !from.model) || (ch.effort !== undefined && !from.effort)) throw new Error("The agent's current model and effort were not reported; use Restart.")
  if (kind === 'codex') await codexSwitch(io, from, to, names)
  else {
    const steps = kind === 'pi' ? piSteps(ch) : claudeSteps(ch)
    const run = () => typed(io, steps, from)
    if (kind === 'claude') await withClaudeDefaults(io, run)
    else await run()
  }
  return ch
}
