// Coordinators: one agent per place. Each does what the human asks, and Autopilot is a switch on top of it:
// then it also works on its own.
// The switch is at the top of the coordinator chat's ⋯ menu, over search and the terminal. While Autopilot is on, a small
// red pill at the header's right, beside that menu (on a phone after the subtitle, under the name), says so, and a tap
// on it opens the menu; with it off the header says nothing of it. Beside the pill is Run now: one wake of its
// coordinator at once, one per tap, refused (and shown as Queued or Waking) while a wake already waits or runs.
import { act, definePlugin, has, setUI, useUI } from '@client/kernel.ts'
import { ic, MenuSwitch, ModeIcon, PlayIcon } from '@client/ui.tsx'
import { useEffect, useState } from 'react'
import type { Place } from '@shared/types.ts'

/** Autopilot on, as a red pill with a dot: at the header's right, or after the subtitle on a phone; a tap opens the ⋯
 *  menu, where it is switched off. Nothing when off */
function AutopilotPill({ place }: { place: Place }) {
  const menu = useUI((u) => u.menu)
  return place.mode === 'autopilot' ? (
    <button
      type="button"
      data-mode="autopilot"
      aria-label="Autopilot is on. Change it"
      aria-haspopup="menu"
      aria-expanded={menu}
      className="mode-pill hit press"
      onClick={() => setUI({ menu: !menu, plus: null, pick: null })}
    >
      <span>Autopilot</span>
    </button>
  ) : null
}

/** Autopilot's Run now, beside the pill: one heartbeat to this coordinator now (or once its turn is over), for the
 *  human to poke a quiet night and see it is alive. One wake per tap: while one waits or runs it is off, saying
 *  Queued or Waking, and what a refusal says stands beside it for a few seconds, on a phone too. A phone keeps only the
 *  arrow, which its label names */
function AutopilotRunNow({ place }: { place: Place }) {
  const phone = useUI((u) => u.device === 'phone')
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState('')
  // why it did not wake is read once and goes: no room in a header for a sentence that stays
  useEffect(() => {
    if (!refused) return
    const t = setTimeout(() => setRefused(''), 8000)
    return () => clearTimeout(t)
  }, [refused])
  const state = place.runNow
  if (!state) return null
  const waiting = busy || state !== 'ready'
  const run = async () => {
    if (waiting) return
    setBusy(true)
    setRefused('')
    try {
      const r = (await act({ type: 'heartbeat', place: place.id, op: 'run' })) as { ok?: boolean; error?: string } | undefined
      if (r?.ok === false) setRefused(r.error ?? 'It did not wake.')
    } catch (e) {
      setRefused((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const words = state === 'queued' ? 'Queued' : state === 'waking' ? 'Waking' : 'Run now'
  return (
    <>
      <button
        type="button"
        data-run-now
        disabled={waiting}
        onClick={() => void run()}
        aria-label={`Run now: wake ${place.name}'s coordinator for one heartbeat`}
        title={refused || words}
        className="hit press inline-flex shrink-0 items-center gap-1 self-center rounded-full px-1.5 py-0.5 text-[0.75rem]/none font-medium text-fg2 ring-1 ring-line hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent phone:px-1"
      >
        <PlayIcon aria-hidden className="size-3 shrink-0" />
        {phone ? <span className="sr-only">{words}</span> : <span>{words}</span>}
      </button>
      {refused ? (
        <span role="status" title={refused} className="max-w-[9rem] shrink truncate text-[0.75rem] text-need phone:max-w-[6.5rem]">
          {refused}
        </span>
      ) : null}
    </>
  )
}

/** Autopilot on or off at the top of the ⋯ menu */
function AutopilotSwitch({ place }: { place: Place }) {
  const on = place.mode === 'autopilot'
  if (!on && !has('autopilot')) return null
  return (
    <MenuSwitch
      name="Autopilot"
      icon={<ModeIcon className={ic} />}
      on={on}
      note={on ? 'Works on its own' : 'Off: does what you ask'}
      onClick={() => act({ type: 'mode', place: place.id, mode: on ? 'regular' : 'autopilot' })}
    />
  )
}

export default definePlugin({
  name: 'coordinators',
  setup(reg) {
    reg.placeMark.push({ order: 10, View: AutopilotPill })
    reg.placeMark.push({ order: 11, View: AutopilotRunNow })
    reg.placeMenu.push({ order: 10, View: AutopilotSwitch })
  },
})
