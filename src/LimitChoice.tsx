// A limit's three choices (the operator's rule: 0 is a limit of its own, not "no cap"): No cap (unlimited, "off"), a zero
// choice (blocked: nothing starts on it, 0 allowed; for a task count "0 · starts none"), and Limit: a number from 1 to max.
// The three are separate radio buttons, so none reads as another. Used by every limit editor: a Settings row, a Limits cell,
// and the cap editor of a model row (CapEditor, which keeps its draft until Save).
import clsx from 'clsx'
import { useEffect, useId, useRef, useState } from 'react'

/** the mode a stored limit value is in: none (off, or nothing), zero (0), or a number */
export type LimitMode = 'none' | 'zero' | 'limit'

/** a stored limit value as its mode and, for a number, the digits ('' for none and zero) */
export function limitMode(value: string): { mode: LimitMode; n: string } {
  const v = value.trim().toLowerCase()
  // '' is a Limit with no number yet (a draft), never no cap: no cap is off
  if (v === '') return { mode: 'limit', n: '' }
  if (v === 'off') return { mode: 'none', n: '' }
  const x = Number.parseFloat(v)
  if (Number.isFinite(x) && x === 0) return { mode: 'zero', n: '' }
  return { mode: 'limit', n: Number.isFinite(x) ? String(Math.round(x)) : '' }
}

/** a stored limit in words for a cell: no cap (faint), 0 (blocked: the zero words, in the warning color), or the number */
export function limitWords(value: string, zero = '0 · starts none'): { words: string; tone: LimitMode } {
  const m = limitMode(value)
  if (m.mode === 'none') return { words: 'no cap', tone: 'none' }
  if (m.mode === 'zero') return { words: zero, tone: 'zero' }
  return { words: m.n || value, tone: 'limit' }
}

/** the value a choice stands for once it is complete: 'off' (no cap), '0' (blocked), or the whole number from 1 to max; ''
 *  while a Limit has no valid number yet */
export function limitValue(mode: LimitMode, n: string, max: number): string {
  if (mode === 'none') return 'off'
  if (mode === 'zero') return '0'
  const x = Number(n)
  return Number.isInteger(x) && x >= 1 && x <= max ? String(x) : ''
}

/** the three choices. `onChange(value, final)`: a radio is final at once, a typed number when it is left (Enter or blur), so a
 *  Settings row saves a number once and not per key; a draft (the cap editor) takes every change as it comes */
export function LimitChoice({ label, value, max, zero = '0 · starts none', onChange, phone = false }: { label: string; value: string; max: number; zero?: string; onChange: (value: string, final: boolean) => void; phone?: boolean }) {
  const id = useId()
  const [mode, setMode] = useState<LimitMode>(() => limitMode(value).mode)
  const [n, setN] = useState(() => limitMode(value).n)
  // the value this choice last gave out: a value that comes back as it was given (a save that landed, a draft kept) is what
  // the choices already show; one from outside (another level's, a reset) is what they show now. A Limit with no number yet
  // gives '', which is no mode of its own, so the Limit choice stays picked while it is empty
  const given = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (value === given.current) return
    setMode(limitMode(value).mode)
    setN(limitMode(value).n)
  }, [value])
  const emit = (m: LimitMode, digits: string, final: boolean) => {
    const v = limitValue(m, digits, max)
    given.current = v
    onChange(v, final)
  }
  const pick = (m: LimitMode) => {
    setMode(m)
    emit(m, n, true)
  }
  const typed = (x: string, final: boolean) => {
    const digits = x.replace(/[^\d]/g, '')
    // left empty: the number it had stays. Left out of range: what was typed goes on, so the setting says why it is refused
    if (final && digits === '') return setN(limitMode(value).n)
    setN(digits)
    const v = limitValue('limit', digits, max)
    const out = v === '' && final ? digits : v
    given.current = out
    onChange(out, final)
  }
  const row = 'flex items-center gap-2 whitespace-nowrap'
  return (
    <fieldset aria-label={label} className={clsx('flex flex-col gap-1.5 text-left', phone && 'w-full')}>
      <legend className="sr-only">{label}</legend>
      <label className={row}>
        <input type="radio" name={`${id}-mode`} checked={mode === 'none'} onChange={() => pick('none')} />
        <span className="text-fg3">No cap</span>
      </label>
      <label className={row}>
        <input type="radio" name={`${id}-mode`} checked={mode === 'zero'} onChange={() => pick('zero')} />
        <span className="font-medium text-need-fg">{zero}</span>
      </label>
      <div className={row}>
        <label className="flex items-center gap-2">
          <input type="radio" name={`${id}-mode`} checked={mode === 'limit'} onChange={() => pick('limit')} />
          <span>Limit</span>
        </label>
        <input
          type="text"
          inputMode="numeric"
          aria-label={`Limit, from 1 to ${max}`}
          placeholder={`1–${max}`}
          value={n}
          disabled={mode !== 'limit'}
          onFocus={() => setMode('limit')}
          onChange={(e) => typed(e.target.value, false)}
          onBlur={(e) => typed(e.target.value, true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          className="w-20 rounded-row bg-bg px-2 py-0.5 text-right tabular-nums shadow-[inset_0_0_0_1px_var(--line2)] outline-none focus:shadow-box-focus disabled:opacity-40 dark:bg-bubble"
        />
      </div>
    </fieldset>
  )
}
