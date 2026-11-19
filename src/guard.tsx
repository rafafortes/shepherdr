// A plugin of the human's own (~/.shepherdr/plugins) can't take the screen down: its setup runs in a try, and whatever
// it adds to the slots is wrapped, so an error in it stops only that plugin's parts. Settings → Plugins says why.
import { Component, createElement, useSyncExternalStore, type FC, type ReactNode } from 'react'

let errors: Record<string, string> = {}
const listeners = new Set<() => void>()

/** a plugin of the human's own failed on this screen: its first error is kept */
export function pluginFailed(name: string, e: unknown) {
  if (errors[name]) return
  console.error(`plugin ${name} failed, so its parts are stopped:`, e)
  errors = { ...errors, [name]: e instanceof Error ? e.message : String(e) }
  for (const l of listeners) l()
}

/** the human's own plugins that failed on this screen, by name */
export const usePluginErrors = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => errors,
  )

class Boundary extends Component<{ name: string; children?: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(e: unknown) {
    pluginFailed(this.props.name, e)
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

/** a plugin's view that draws nothing once it throws */
export function guardView<P extends object>(name: string, View: FC<P>): FC<P> {
  const Guarded: FC<P> = (props) => createElement(Boundary, { name }, createElement(View, props))
  Guarded.displayName = `${name}(${View.displayName ?? View.name ?? 'view'})`
  return Guarded
}

/** a plugin's function (a key handler, a test, an action) that gives `fallback` once it throws */
export function guardFn<A extends unknown[], R>(name: string, f: (...a: A) => R, fallback: R): (...a: A) => R {
  return (...a) => {
    try {
      const r = f(...a)
      return r instanceof Promise ? (r.catch((e) => (pluginFailed(name, e), fallback)) as R) : r
    } catch (e) {
      pluginFailed(name, e)
      return fallback
    }
  }
}

/** the parts of a slot item that are views; the rest of its functions are plain ones */
const VIEWS = new Set(['View', 'Icon'])

/** Run a plugin of the human's own's setup: on an error the registry is as it was before, and each part it added is
 *  wrapped. */
export function setupGuarded<R extends object>(name: string, registry: R, setup: (r: R) => void) {
  const reg = registry as Record<string, unknown>
  const before: Record<string, unknown> = Object.fromEntries(
    Object.entries(reg).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v && typeof v === 'object' ? { ...v } : v]),
  )
  try {
    setup(registry)
  } catch (e) {
    for (const [k, v] of Object.entries(before)) {
      if (Array.isArray(v)) (reg[k] as unknown[]).splice(0, Infinity, ...v)
      else if (v && typeof v === 'object') {
        const now = reg[k] as Record<string, unknown>
        for (const kk of Object.keys(now)) delete now[kk]
        Object.assign(now, v)
      } else reg[k] = v
    }
    return pluginFailed(name, e)
  }
  const fallback = (k: string) => (k === 'useOff' ? null : k === 'settingActions' ? 'That failed.' : false)
  const item = (x: unknown): unknown => {
    if (typeof x === 'function') return guardView(name, x as FC)
    if (!x || typeof x !== 'object') return x
    return Object.fromEntries(
      Object.entries(x).map(([k, v]) => [k, typeof v !== 'function' ? v : VIEWS.has(k) ? guardView(name, v as FC) : guardFn(name, v as () => unknown, fallback(k))]),
    )
  }
  for (const [k, v] of Object.entries(reg)) {
    const was = before[k]
    if (Array.isArray(v)) reg[k] = v.map((x) => ((was as unknown[]).includes(x) ? x : item(x)))
    else if (typeof v === 'function') {
      if (v !== was) reg[k] = guardView(name, v as FC)
    } else if (v && typeof v === 'object') {
      const old = was as Record<string, unknown>
      for (const [kk, vv] of Object.entries(v)) {
        if (vv === old[kk] || typeof vv !== 'function') continue
        ;(v as Record<string, unknown>)[kk] = k === 'settingActions' ? guardFn(name, vv as () => unknown, fallback(k)) : guardView(name, vv as FC)
      }
    }
  }
}

/* ---------- a break outside any plugin: a way out instead of a blank screen ---------- */

const CRASH_KEY = 'shepherdr.screen-crash'
/** how long after a Reload a repeat still counts as another try of the same break */
const RELOAD_WINDOW = 60_000
/** how many tries of the same break (the first, then each Reload) before the card says to restart instead */
export const CRASH_RELOADS = 3

export interface ScreenCrash {
  message: string
  count: number
  /** the card's Reload was pressed: the next break of the same kind is another try, not a new break */
  reloaded: boolean
  at: number
}

/** The count on this screen: a repeat of the same break within a minute of a Reload is another try. React can call
 *  the error lifecycle twice for one break, so a repeat without a Reload keeps the count instead of starting over. */
export function nextCrash(prev: ScreenCrash | null, message: string, now = Date.now()): ScreenCrash {
  if (prev && prev.message === message && now - prev.at < RELOAD_WINDOW) return { message, count: prev.reloaded ? prev.count + 1 : prev.count, reloaded: false, at: now }
  return { message, count: 1, reloaded: false, at: now }
}

/** private windows can block storage: the card still works, without a count across reloads */
function storage(): Storage | null {
  try {
    return sessionStorage
  } catch {
    return null // coverage-exempt: sessionStorage is blocked in a private window
  }
}

function readCrash(s: Storage | null = storage()): ScreenCrash | null {
  if (!s) return null // coverage-exempt: storage is blocked
  try {
    const raw = s.getItem(CRASH_KEY)
    return raw ? (JSON.parse(raw) as ScreenCrash) : null
  } catch {
    return null // coverage-exempt: a value left by an older build can be unreadable
  }
}

function keepCrash(c: ScreenCrash) {
  const s = storage()
  if (!s) return // coverage-exempt: storage is blocked
  try {
    s.setItem(CRASH_KEY, JSON.stringify(c))
  } catch {
    // coverage-exempt: storage can be full; the card still counts in memory
  }
}

/** the Reload button remembers it was pressed, so the same break coming back is counted as another try */
function reloadScreen() {
  const c = readCrash()
  if (c) keepCrash({ ...c, reloaded: true })
  location.reload()
}

/** a small card with nothing of its own: it draws before the first snapshot and with no registry or plugin loaded */
function Crashed({ crash }: { crash: ScreenCrash }) {
  // App is gone, so its data-device is too: name it here for the phone/coarse sizes (the same cut-offs as kernel)
  return (
    <div data-screen-crash data-device={innerWidth < 800 ? 'phone' : innerWidth < 1024 ? 'tablet' : 'desktop'} role="alert" className="grid h-full place-items-center bg-bg px-6 font-sans text-sm/5 text-fg antialiased phone:text-base/6">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <h1 className="text-base font-semibold">Something on the screen broke.</h1>
        <p className="text-fg2">
          {crash.count >= CRASH_RELOADS
            ? `Reloading hasn't fixed this after ${crash.count} tries. Restart Shepherdr from herdr, or check for an update.`
            : 'Reload to try again.'}
        </p>
        <button type="button" onClick={reloadScreen} className="press-dim inline-flex h-[34px] shrink-0 items-center rounded-full bg-fg px-3.5 font-medium text-bg coarse:h-11 phone:h-11">
          Reload
        </button>
        <details className="w-full text-left text-[0.8125rem] text-fg3">
          <summary className="cursor-pointer">Show the error</summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono">{crash.message}</pre>
        </details>
      </div>
    </div>
  )
}

/** around <App />: a render break anywhere under it gets a way out, not a blank document */
export class ScreenBoundary extends Component<{ children?: ReactNode }, { crash: ScreenCrash | null }> {
  state = { crash: null as ScreenCrash | null }
  static getDerivedStateFromError(e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    const crash = nextCrash(readCrash(), message)
    keepCrash(crash)
    return { crash }
  }
  componentDidCatch(e: unknown) {
    console.error('the screen broke:', e)
  }
  render() {
    const { crash } = this.state
    return crash ? <Crashed crash={crash} /> : this.props.children
  }
}
