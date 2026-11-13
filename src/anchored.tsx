// A surface fixed beside its anchor: the popovers and menus of Settings → Models. Drawn at the top of the page (a portal),
// so no sticky cell or a table's scroll paints over or clips it, and it follows its anchor as the page or the table scrolls.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** a surface on a desktop, fixed on the screen beside its anchor (the element it sits in: a cell, a header's button):
 *  below it, above where it would run off the bottom, aligned to its left (or right) edge. It is drawn at the top of the
 *  page (a portal), so no sticky cell or the table's scroll paints over or clips it, and it follows the anchor as the page
 *  or the table scrolls */
export function Anchored({ end = false, children }: { end?: boolean; children: ReactNode }) {
  const marker = useRef<HTMLSpanElement>(null)
  const ref = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    const place = () => {
      const anchor = marker.current?.parentElement?.getBoundingClientRect()
      const box = ref.current?.getBoundingClientRect()
      if (!anchor || !box) return
      const top = anchor.bottom + 4 + box.height > innerHeight ? Math.max(8, anchor.top - box.height - 4) : anchor.bottom + 4
      const left = end ? anchor.right - box.width : anchor.left
      setAt({ top, left: Math.min(Math.max(8, left), innerWidth - box.width - 8) })
    }
    place()
    // a scroll moves the anchor: the surface moves with it (a scroll inside it is its own, and leaves it where it is)
    const scrolled = (e: Event) => !ref.current?.contains(e.target as Node) && place()
    addEventListener('scroll', scrolled, true)
    return () => removeEventListener('scroll', scrolled, true)
  }, [end])
  return (
    <>
      <span ref={marker} hidden />
      {createPortal(
        <div ref={ref} style={at ?? { visibility: 'hidden' }} className="fixed z-40">
          {children}
        </div>,
        document.body,
      )}
    </>
  )
}
