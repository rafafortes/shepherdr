// The full-screen picture viewer: open a shot, page through the chat's pictures, pinch or double-tap to zoom, drag
// to look around, swipe it away, tap or press Esc to close. Split from the chat client so the gallery's own state and
// gestures live together; only Photo is public, everything else here is private to the viewer.
import clsx from 'clsx'
import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { has, setUI, useUI, type UI } from '@client/kernel.ts'
import { BackIcon, DownloadIcon, NextIcon, PlusIcon, XIcon, ic } from '@client/ui.tsx'
import { still } from '@client/motion.ts'
import { isImage } from '@shared/files.ts'
import type { Chat, Message } from '@shared/types.ts'
import { mine, openPicker, quick, react } from '@plugins/reactions/client.tsx'
import { fileUrl, isPicture, useChat } from './client.tsx'

type Shot = { file: { name: string; path: string }; msg?: Message }

/** what the viewer pages through: every picture in the chat, or the ones still waiting in the message box */
function shotsOf(photo: NonNullable<UI['photo']>, chat: Chat | undefined, waiting: { name: string; path?: string }[]): Shot[] {
  // biome-ignore lint/style/noNonNullAssertion: moved verbatim from client.tsx; the finding predates this split
  if (photo.msg) return (chat?.messages ?? []).filter(isPicture).map((m) => ({ file: m.file!, msg: m }))
  // biome-ignore lint/style/noNonNullAssertion: moved verbatim from client.tsx; the finding predates this split
  return waiting.filter((f) => f.path && isImage(f.name)).map((f) => ({ file: { name: f.name, path: f.path! } }))
}

/** a picture opened full screen: swipe or use the arrow keys for the others, pinch or double-tap to zoom, drag to look
 *  around, swipe it away, tap or press Esc to close */
export function Photo() {
  const ui = useUI()
  const chat = useChat(ui.photo?.chat ?? '')
  if (!ui.photo) return null
  const photo = ui.photo
  const all = shotsOf(photo, chat, ui.files[photo.chat] ?? [])
  let at = all.findIndex((s) => (photo.msg ? s.msg?.id === photo.msg : s.file.path === photo.file?.path))
  // one no longer in the chat or the box shows on its own
  const shots = at < 0 && photo.file ? [{ file: photo.file }] : all
  if (at < 0) at = 0
  const shot = shots[at]
  if (!shot) return null
  const go = (s: Shot) => setUI({ photo: s.msg ? { chat: photo.chat, msg: s.msg.id } : { chat: photo.chat, file: s.file } })
  return <PhotoView key={shot.msg?.id ?? shot.file.path} shots={shots} at={at} go={go} chatKey={photo.chat} />
}

type Pt = { x: number; y: number }
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
const mid = (a: Pt, b: Pt) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
const MAX_ZOOM = 5
/** the dark space between two pictures as they slide past */
const GAP = 16

function PhotoView({ shots, at: index, go, chatKey }: { shots: Shot[]; at: number; go: (s: Shot) => void; chatKey: string }) {
  const { file: f, msg } = shots[index]
  const prev = shots[index - 1]
  const next = shots[index + 1]
  const box = useRef<HTMLDivElement>(null)
  const strip = useRef<HTMLDivElement>(null)
  const img = useRef<HTMLImageElement>(null)
  const shade = useRef<HTMLDivElement>(null)
  const closeBtn = useRef<HTMLButtonElement>(null)
  const [broken, setBroken] = useState(false)
  /** the picture's zoom and how far it is moved from the middle */
  const v = useRef({ s: 1, x: 0, y: 0 })
  const pts = useRef(new Map<number, Pt>())
  /** the gesture under way, from where it started; a swipe picks its way (across to page, up or down to close) */
  const g = useRef<{ kind: 'pinch' | 'pan' | 'swipe'; d0: number; s0: number; m0: Pt; t0: Pt; axis?: 'x' | 'y' } | null>(null)
  /** since the first finger went down: did it move, was it ever two fingers */
  const touch = useRef({ at: 0, start: { x: 0, y: 0 }, moved: false, multi: false })
  const lastTap = useRef(0)
  const tapTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const sliding = useRef<ReturnType<typeof setTimeout>>(undefined)
  const close = () => setUI({ photo: null })

  const draw = (animate = false) => {
    const el = img.current
    if (!el) return
    // with reduced motion it lands at once
    el.style.transition = animate && !still() ? 'transform 200ms ease-out' : ''
    el.style.transform = `translate(${v.current.x}px, ${v.current.y}px) scale(${v.current.s})`
  }
  const shift = (x: number, animate = false) => {
    const el = strip.current
    if (!el) return
    el.style.transition = animate && !still() ? 'transform 220ms ease-out' : ''
    el.style.transform = `translateX(${x}px)`
  }
  /** slide to the one before (-1) or after (1); at either end it stays */
  const page = (dir: 1 | -1) => {
    const to = dir > 0 ? next : prev
    if (sliding.current) return
    if (!to) return shift(0, true)
    // biome-ignore lint/style/noNonNullAssertion: moved verbatim from client.tsx; the finding predates this split
    shift(-dir * (box.current!.clientWidth + GAP), true)
    sliding.current = setTimeout(() => go(to), still() ? 0 : 220)
  }
  /** keep a zoomed picture over the screen: no empty space past its edges */
  const settle = () => {
    const el = img.current
    const b = box.current
    if (!el || !b) return
    const { s } = v.current
    if (s <= 1.01) v.current = { s: 1, x: 0, y: 0 }
    else {
      const mx = Math.max(0, (el.offsetWidth * s - b.clientWidth) / 2)
      const my = Math.max(0, (el.offsetHeight * s - b.clientHeight) / 2)
      v.current.x = Math.min(mx, Math.max(-mx, v.current.x))
      v.current.y = Math.min(my, Math.max(-my, v.current.y))
    }
    draw(true)
  }
  /** zoom to s, keeping the point p (from the middle of the screen) where it is */
  const zoomAt = (s: number, p: Pt, from = v.current) => {
    const k = s / from.s
    v.current = { s, x: p.x - (p.x - from.x) * k, y: p.y - (p.y - from.y) * k }
  }
  const at = (e: { clientX: number; clientY: number }): Pt => {
    // biome-ignore lint/style/noNonNullAssertion: moved verbatim from client.tsx; the finding predates this split
    const r = box.current!.getBoundingClientRect()
    return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 }
  }
  const begin = () => {
    const [a, b] = [...pts.current.values()]
    const t0 = { x: v.current.x, y: v.current.y }
    g.current = b ? { kind: 'pinch', d0: dist(a, b), s0: v.current.s, m0: mid(a, b), t0 } : { kind: v.current.s > 1 ? 'pan' : 'swipe', d0: 0, s0: v.current.s, m0: a, t0 }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only on purpose; PhotoView remounts per shot (moved from client.tsx)
  useEffect(() => {
    closeBtn.current?.focus({ preventScroll: true })
    // a mouse wheel or trackpad pinch zooms where the pointer is
    // biome-ignore lint/style/noNonNullAssertion: moved verbatim from client.tsx; the finding predates this split
    const el = box.current!
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      zoomAt(Math.min(MAX_ZOOM, Math.max(1, v.current.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)))), at(e))
      if (v.current.s === 1) v.current = { s: 1, x: 0, y: 0 }
      draw()
      clearTimeout(tapTimer.current)
      tapTimer.current = setTimeout(settle, 150)
    }
    // the arrow keys page through them
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.preventDefault()
      page(e.key === 'ArrowRight' ? 1 : -1)
    }
    el.addEventListener('wheel', wheel, { passive: false })
    addEventListener('keydown', key)
    return () => {
      el.removeEventListener('wheel', wheel)
      removeEventListener('keydown', key)
      clearTimeout(tapTimer.current)
      // closed mid-slide: it doesn't open again on the next one
      clearTimeout(sliding.current)
    }
  }, [])

  const down = (e: PointerEvent) => {
    if (e.button > 0 || sliding.current) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = at(e)
    if (!pts.current.size) touch.current = { at: Date.now(), start: p, moved: false, multi: false }
    pts.current.set(e.pointerId, p)
    if (pts.current.size > 1) touch.current.multi = true
    begin()
  }
  const move = (e: PointerEvent) => {
    if (!pts.current.has(e.pointerId) || !g.current) return
    const p = at(e)
    pts.current.set(e.pointerId, p)
    if (dist(p, touch.current.start) > 8) touch.current.moved = true
    const { kind, d0, s0, m0, t0 } = g.current
    if (kind === 'pinch') {
      const [a, b] = [...pts.current.values()]
      const m = mid(a, b)
      zoomAt(Math.min(MAX_ZOOM, Math.max(1, (s0 * dist(a, b)) / d0)), m0, { s: s0, ...t0 })
      v.current.x += m.x - m0.x
      v.current.y += m.y - m0.y
    } else if (kind === 'pan') v.current = { s: s0, x: t0.x + p.x - m0.x, y: t0.y + p.y - m0.y }
    else {
      const dx = p.x - m0.x
      const dy = p.y - m0.y
      if (!g.current.axis) {
        if (Math.hypot(dx, dy) < 8) return
        g.current.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
      }
      // across: the row of pictures follows the finger, holding back at either end
      if (g.current.axis === 'x') return shift((dx > 0 ? prev : next) ? dx : dx / 3)
      // up or down: it follows the finger away and the dark behind it fades
      v.current = { s: 1, x: 0, y: dy }
      if (shade.current) shade.current.style.opacity = String(Math.max(0.3, 1 - Math.abs(dy) / 400))
    }
    draw()
  }
  const up = (e: PointerEvent) => {
    if (!pts.current.delete(e.pointerId)) return
    // a finger lifted from a pinch: the other one goes on moving it
    if (pts.current.size) return begin()
    const gesture = g.current
    g.current = null
    if (gesture?.kind === 'swipe' && gesture.axis === 'x') {
      const dx = at(e).x - gesture.m0.x
      // biome-ignore lint/style/noNonNullAssertion: moved verbatim from client.tsx; the finding predates this split
      if (Math.abs(dx) > Math.min(80, box.current!.clientWidth / 5) && e.type !== 'pointercancel') page(dx < 0 ? 1 : -1)
      else shift(0, true)
      return
    }
    if (gesture?.kind === 'swipe' && Math.abs(v.current.y) > 100) {
      if (still()) return close()
      // it carries on off the screen
      v.current.y = Math.sign(v.current.y) * innerHeight
      draw(true)
      setTimeout(close, 180)
      return
    }
    if (shade.current) shade.current.style.opacity = '1'
    settle()
    const t = touch.current
    if (t.moved || t.multi || Date.now() - t.at > 350 || e.type === 'pointercancel') return
    // a tap: two quick ones zoom in (or back out); one closes when it isn't zoomed
    clearTimeout(tapTimer.current)
    if (Date.now() - lastTap.current < 300) {
      lastTap.current = 0
      if (v.current.s > 1) v.current = { s: 1, x: 0, y: 0 }
      else zoomAt(2.5, t.start)
      settle()
    } else {
      lastTap.current = Date.now()
      tapTimer.current = setTimeout(() => v.current.s <= 1 && close(), 260)
    }
  }

  // the bars over the picture take their own taps: they start no gesture
  const own = { onPointerDown: (e: PointerEvent) => e.stopPropagation(), onPointerUp: (e: PointerEvent) => e.stopPropagation() }
  const barBtn = 'grid size-10 shrink-0 place-items-center rounded-full bg-white/12 text-white hover:bg-white/20 phone:size-11'
  // with a mouse, round arrows on either side page through them
  const sideBtn =
    'absolute top-1/2 hidden size-11 -translate-y-1/2 place-items-center rounded-full bg-black/45 text-white shadow-[0_0_0_1px_rgb(255_255_255/0.12)] backdrop-blur-sm hover:bg-black/65 pointer-fine:grid'
  const neighbour = (s: Shot | undefined, side: 'left' | 'right') =>
    s ? (
      <div aria-hidden="true" className={clsx('absolute inset-y-0 grid w-full place-items-center', side === 'left' ? 'right-[calc(100%+16px)]' : 'left-[calc(100%+16px)]')}>
        <img src={fileUrl(chatKey, s.file.path)} alt="" draggable={false} className="max-h-full max-w-full object-contain" />
      </div>
    ) : null
  return (
    <div role="dialog" aria-modal="true" aria-label={f.name} className="fixed inset-0 z-50 overflow-hidden text-white">
      <div ref={shade} className="absolute inset-0 bg-black" />
      <div ref={box} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} className="absolute inset-0 touch-none select-none [-webkit-touch-callout:none]">
        <div ref={strip} className="absolute inset-0 will-change-transform">
          {neighbour(prev, 'left')}
          <div className="absolute inset-0 grid place-items-center">
            {broken ? (
              <p className="px-8 text-center text-white/70">This picture can't be shown here. Download it to open it.</p>
            ) : (
              <img ref={img} src={fileUrl(chatKey, f.path)} alt={f.name} draggable={false} onError={() => setBroken(true)} className="max-h-full max-w-full object-contain will-change-transform" />
            )}
          </div>
          {neighbour(next, 'right')}
        </div>
      </div>
      <div {...own} className="absolute inset-x-0 top-0 flex items-center gap-2 bg-linear-to-b from-black/60 to-transparent px-3 pt-[calc(env(safe-area-inset-top)+10px)] pb-6">
        <div className="min-w-0 flex-1 pl-1">
          <div className="truncate text-[0.8125rem] text-white/80 phone:text-[0.9375rem]">{f.name}</div>
          {shots.length > 1 ? <div className="text-[0.75rem] text-white/55 tabular-nums phone:text-[0.8125rem]">{`${index + 1} of ${shots.length}`}</div> : null}
        </div>
        <a href={fileUrl(chatKey, f.path, true)} download={f.name} aria-label={`Download ${f.name}`} className={barBtn}>
          <DownloadIcon className={ic} />
        </a>
        <button ref={closeBtn} type="button" aria-label="Close" onClick={close} className={barBtn}>
          <XIcon className={ic} />
        </button>
      </div>
      {prev ? (
        <button {...own} type="button" aria-label="Previous picture" onClick={() => page(-1)} className={clsx(sideBtn, 'left-3')}>
          <BackIcon className={ic} />
        </button>
      ) : null}
      {next ? (
        <button {...own} type="button" aria-label="Next picture" onClick={() => page(1)} className={clsx(sideBtn, 'right-3')}>
          <NextIcon className={ic} />
        </button>
      ) : null}
      {msg && has('reactions') && !msg.waiting ? (
        <div {...own} className="absolute inset-x-0 bottom-0 flex justify-center bg-linear-to-t from-black/60 to-transparent px-3 pt-6 pb-[calc(env(safe-area-inset-bottom)+14px)]">
          {/* biome-ignore lint/a11y/useSemanticElements: moved verbatim from client.tsx; the finding predates this split */}
          <div role="group" aria-label="React" className="inline-flex gap-0.5 rounded-full bg-white/12 p-1">
            {quick().map((e) => (
              <button
                key={e}
                type="button"
                aria-label={`React ${e}`}
                aria-pressed={mine(msg, e)}
                onClick={() => react(chatKey, msg.id, e)}
                className="size-10 rounded-full text-[1.125rem] hover:bg-white/15 aria-pressed:bg-white/25 phone:size-11 phone:text-[1.25rem]"
              >
                {e}
              </button>
            ))}
            <button
              type="button"
              aria-label="More emoji"
              onClick={() => openPicker(chatKey, msg.id)}
              className="grid size-10 place-items-center rounded-full bg-white/12 hover:bg-white/20 phone:size-11"
            >
              <PlusIcon className={ic} />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
