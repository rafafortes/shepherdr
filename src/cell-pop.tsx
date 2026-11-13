// A cell's popover on a desktop (Settings → Models: the table's cells and the summary's caps): the editor on its surface,
// anchored to the cell. A press outside it closes it, but not one in a dialog (the question about the waiting tasks it
// causes, say: that one is answered, and the editor waits); Escape closes it too, unless a choice list inside it took the
// key first.
import { useEffect, useRef, type ReactNode } from 'react'
import { Anchored } from './anchored.tsx'

/** a cell's popover on a desktop: the editor on its surface, anchored to the cell. A press outside it closes it, but not
 *  one in a dialog (the question about the waiting tasks it causes, say: that one is answered, and the editor waits);
 *  Escape closes it too, unless a choice list inside it took the key first */
export function Pop({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Element
      if (ref.current?.contains(t) || t.closest?.('[role="alertdialog"]')) return
      onClose()
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    addEventListener('pointerdown', down, true)
    addEventListener('keydown', key)
    return () => {
      removeEventListener('pointerdown', down, true)
      removeEventListener('keydown', key)
    }
  }, [onClose])
  return (
    <Anchored>
      <div ref={ref} role="dialog" aria-label="Edit this setting" className="popover text-left">
        {children}
      </div>
    </Anchored>
  )
}
