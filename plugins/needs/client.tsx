// Needs you: every card and every waiting agent that wants an answer, oldest first, in one list. It is the only view of
// what needs you, and the counts beside it (the sidebar's, the phone's Needs you tab) count these same rows, so a number
// and its list never disagree. A row is what waits on top and who asks under it; a tap opens that chat at its card, where
// it is answered by the card's own rule (a pick and Send, a plan's note, the CLI's menu in its terminal). Nothing here
// answers in a second place: one card, answered once.
import clsx from 'clsx'
import { definePlugin, inList, listView, openNeed, placeOf, taskOf, useSnap, useStore } from '@client/kernel.ts'
import { BellIcon, Empty, ic, List, Meta, Row, RowText, TaskDot } from '@client/ui.tsx'
import type { Need, Snapshot } from '@shared/types.ts'

/** what a need says it waits with: its card's title, or the words it waits with when it has none */
const waitsWith = (n: Need) => n.question?.title || n.text || 'Waiting for you'

/** who asks: a task (its id and title) or a space's own coordinator */
function whoAsks(snap: Snapshot, n: Need) {
  const t = n.task ? taskOf(snap, n.task) : undefined
  if (t) return `${t.id} · ${t.name}`
  return `${placeOf(snap, n.place).name} · its coordinator`
}

/** the needs in a list's scope, oldest first: the same rows every count of that scope counts */
export function needsIn(snap: Snapshot, chips: string[]) {
  return (snap.needs ?? []).filter((n) => inList(snap, chips, n.place)).sort((a, b) => a.at - b.at)
}

/** one need: what waits, and where it is answered */
function NeedRow({ n }: { n: Need }) {
  const snap = useSnap()!
  return (
    <Row two className="p-0!" onActivate={() => openNeed(n)} data-need={n.question?.id ?? n.id}>
      <TaskDot s="need" />
      <span className="flex min-h-[inherit] min-w-0 flex-1 flex-col justify-center gap-0.5 py-1.5 pr-1 text-left">
        <RowText sub={whoAsks(snap, n)}>{waitsWith(n)}</RowText>
      </span>
      {n.question?.terminal ? <Meta className="self-start pt-2">Terminal</Meta> : n.question?.kind === 'Plan' ? <Meta className="self-start pt-2">Plan</Meta> : null}
    </Row>
  )
}

/** Everything waiting on you in the lists' scope (placeId, the place picked, is for plugins of old) */
function NeedsView(_: { placeId: string }) {
  const snap = useSnap()!
  const view = useStore((s) => listView(s.ui, snap))
  const needs = needsIn(snap, view.chips)
  if (!needs.length)
    return (
      <div className="flex flex-col gap-1">
        <Heading count={0} />
        <Empty className="flex items-center gap-2">
          <BellIcon className={ic} aria-hidden /> Nothing needs you{view.chips.length ? ' here' : ''}.
        </Empty>
      </div>
    )
  return (
    <div>
      <Heading count={needs.length} />
      <List>
        {needs.map((n) => (
          <NeedRow key={`${n.chat}:${n.id}`} n={n} />
        ))}
      </List>
    </div>
  )
}

/** how many wait on you, over the list: the same count its rows and the badges show */
function Heading({ count }: { count: number }) {
  return (
    <div className="flex min-h-9 items-center gap-1 pt-2 pr-4 pl-1.5 text-[0.75rem] font-medium text-fg3 phone:pt-2.5 phone:pr-5 phone:pl-2 phone:text-[0.875rem]">
      <BellIcon className={clsx(ic, 'text-fg3')} aria-hidden />
      <h3 className="min-w-0 flex-1 truncate">Waiting on you</h3>
      {count ? (
        <span data-count={count} className="shrink-0 tabular-nums">
          {count}
        </span>
      ) : null}
    </div>
  )
}

export default definePlugin({
  name: 'needs',
  setup(reg) {
    reg.views.needs = NeedsView
  },
})
