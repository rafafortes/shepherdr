// Starting an agent in a herdr pane, the one way (SHE-187). A task's agent and a round's reviewer both go through here:
// a freshly created tab's shell is not ready the moment `agent.start` is called, and on herdr 0.9.5 a launch stays
// `launch_pending` until a client asks for that agent by name (issue #491). The launch path (agents.ts) learned both the
// hard way; a reviewer used to start a pane with one `start` and one `prompt`, so those two passing moments fell its
// round back to headless. One path, used by both, instead of a second one with the waits left out.
import { dropped, startDelays } from './herdr.ts'

/** the herdr calls needed to put an agent in a pane and talk to it (the real `herdr` and the tests' fakes both fit) */
export interface PaneAgent {
  agent(target: string): Promise<unknown>
  start(name: string, kind: string, pane_id: string, args?: string[]): Promise<unknown>
  prompt(target: string, text: string): Promise<unknown>
}

/** the waits are injectable so a test can drive them with no clock time; `onTry` says a call is being made, so the
 *  caller can keep its stream warm while a slow herdr takes up to 70 s to answer that one call. */
export interface WaitOpts {
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  forMs?: number
  onTry?: (n: number) => void
  giveUp?: (e: unknown) => void
}

const code = (e: unknown) => (e as { code?: string } | null)?.code
const nap = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const untilOf = (o: WaitOpts) => (o.forMs === undefined ? Infinity : (o.now ?? Date.now)() + o.forMs)

/** a passing refusal while a pane is becoming a shell, or herdr is registering the name it was just given */
const waitingForAgent = (e: unknown) =>
  code(e) === 'agent_not_ready' || code(e) === 'agent_not_found' || code(e) === 'agent_not_running' || /not an active named agent|not an available shell/i.test((e as Error)?.message ?? '')

/**
 * Start in a pane the way a task's launch does (agents.ts): retry a pane whose shell is not there yet, but treat
 * `agent_not_ready` as a launch herdr took and left pending (it never reached the CLI yet, and the nudge below finishes
 * it). A call herdr dropped is left to the caller's retry. `giveUp` says the final failure where the caller logs it.
 */
export async function startInPane(h: PaneAgent, name: string, kind: string, pane: string, args: string[], o: WaitOpts = {}) {
  const sleep = o.sleep ?? nap
  const now = o.now ?? Date.now
  const until = untilOf(o)
  for (let i = 0; ; i++) {
    o.onTry?.(i + 1)
    try {
      await h.start(name, kind, pane, args)
      return
    } catch (e) {
      if (code(e) === 'agent_not_ready') return
      if (i >= 8 || dropped(e) || now() >= until) {
        o.giveUp?.(e)
        throw e
      }
      await sleep(750)
    }
  }
}

/** The launch's whole start: the pane wait above plus the caller's retry of calls herdr drops (agents.ts `again`). A
 *  reviewer used to call `start` once, so a dropped launch fell straight back to headless. */
export async function startPaneAgent(h: PaneAgent, name: string, kind: string, pane: string, args: string[], o: WaitOpts = {}) {
  const sleep = o.sleep ?? nap
  const now = o.now ?? Date.now
  const until = untilOf(o)
  const delays = startDelays()
  for (let i = 0; ; i++) {
    try {
      return await startInPane(h, name, kind, pane, args, { ...o, forMs: undefined })
    } catch (e) {
      if (!dropped(e) || i >= delays.length || now() >= until) throw e
      o.onTry?.(i + 1)
      await sleep(delays[i])
    }
  }
}

/** herdr 0.9.5 finishes a pending launch only when a client asks for that agent by name (issue #491). A name it already
 *  registered, or one it dropped, answers at once or not found; neither is a failure of the round. */
export async function completeLaunch(h: PaneAgent, name: string) {
  await h.agent(name).catch(() => undefined)
}

/**
 * Send the first message to a named agent the way the outbox does (agents.ts holdFrom + deliver): while herdr says the
 * name is not its agent yet (or its pane is not a shell yet), ask for it by name to finish the launch, wait, and send
 * again. `forMs` is the same minute the launch gives an unready agent (agents.ts unreadyFor); `tries` also bounds it so
 * a fake with an instant clock cannot spin for ever. `onTry` and `onWait` let a long wait say it is still going. A
 * failure that is not one of those passing moments is thrown at once, so a real provider error is never hidden.
 */
export async function sendWhenReady(h: PaneAgent, name: string, text: string, o: WaitOpts & { poll?: number; tries?: number; onWait?: (n: number) => void } = {}) {
  const sleep = o.sleep ?? nap
  const now = o.now ?? Date.now
  const poll = o.poll ?? 1000
  const tries = o.tries ?? 60
  const until = untilOf(o)
  for (let i = 0; ; i++) {
    o.onTry?.(i + 1)
    try {
      await h.prompt(name, text)
      return
    } catch (e) {
      if (!waitingForAgent(e) || i >= tries - 1 || now() >= until) throw e
      await completeLaunch(h, name)
      o.onWait?.(i + 1)
      await sleep(poll)
    }
  }
}
