// A task's scope, as the space's Assistant wrote it, shown as a card at the top of the task's page. The whole brief is
// still what its agent got; here the human's words are easy to read before the agent starts, and the launch message in
// the chat needn't repeat them (the 2.0 port of upstream SHEP-330). The Settings block is folded away, not thrown away.
import clsx from 'clsx'
import { useLayoutEffect, useRef, useState } from 'react'
import { readBrief } from '@shared/brief.ts'
import type { Chat, Message, Task } from '@shared/types.ts'
import { ClockIcon, DownIcon, ic } from './ui.tsx'

export type BriefState = 'waiting' | 'sent' | 'read'

/** who wrote the brief, over it: the space's Assistant */
export function briefFrom(space: string | undefined): string {
  return space ? `From the Assistant in #${space}` : 'From the Assistant'
}

/** whether its agent has the brief, under the card */
export function deliveryWord(state: BriefState): string {
  return state === 'read' ? 'Read' : state === 'sent' ? 'Sent' : 'Not sent yet'
}

/** a brief longer than its few shown lines (six, about 40 characters each on a phone): it starts folded, with Show all.
 *  The card measures it once drawn and corrects this first guess. */
export function looksLong(text: string): boolean {
  const lines = text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 40)), 0)
  return lines > 6
}

/** the human's scope and the Settings block's lines, read from the brief's shared shape. No block: all of it is scope. */
export function briefOf(task: Task): { scope: string; settings: string[] } {
  const desc = task.desc?.trim() ?? ''
  const read = readBrief(desc)
  if (!read) return { scope: desc, settings: [] }
  return {
    scope: [read.before, read.after].filter(Boolean).join('\n\n'),
    settings: read.lines.map((l) => `${l.label ? `${l.label}: ` : ''}${l.text}${l.by ? ` (${l.by})` : ''}`),
  }
}

/** whether there is a brief to show (an old task without one keeps its empty page) */
export function hasBrief(task: Task): boolean {
  return !!task.desc && task.desc.trim() !== '' && task.desc !== 'No brief yet.'
}

/** the launch message holding this brief in a task's chat: the first thing you sent, with its words in it */
export function isBriefMessage(msg: Message | undefined, scope: string, desc?: string): boolean {
  if (msg?.who !== 'you' || !msg.text) return false
  return (scope.length > 0 && msg.text.includes(scope)) || (!!desc && msg.text.includes(desc))
}

/** the launch message holding this brief, wherever it sits (a card or a wake line may come first) */
export function briefMessageOf(chat: Chat | undefined, scope: string, desc?: string): Message | undefined {
  return chat?.messages.slice(0, 4).find((m) => isBriefMessage(m, scope, desc))
}

/** waiting: no agent yet; sent: its agent started and hasn't taken the brief in; read: its chat has the launch message */
export function briefState(task: Task, chat: Chat | undefined): BriefState {
  if (!task.agent) return 'waiting'
  if (!chat) return 'sent'
  const { scope } = briefOf(task)
  if (briefMessageOf(chat, scope, task.desc)) return 'read'
  return chat.messages.some((m) => m.who === 'agent') ? 'read' : 'sent'
}

/** before its agent is at work, what the task waits for, in words under its brief: never an empty page */
export function startWords(task: Task, chat: Chat | undefined): string {
  if (task.status === 'scheduled') return task.sub ? `Scheduled. ${task.sub}.` : 'Scheduled. It starts by itself.'
  if (task.status === 'queued')
    return task.after?.length ? `Queued. It starts when ${task.after.join(', ')} ${task.after.length === 1 ? 'is' : 'are'} done.` : 'Queued. It starts when the tasks before it are done.'
  if (task.status === 'todo') return 'Not started yet. It starts when you say go.'
  if (task.status !== 'work' || !task.agent || !chat) return ''
  // its agent is up, but nothing from it yet: it is opening and taking the brief in
  if (chat.messages.some((m) => m.who === 'agent' && (m.text || m.activity || m.question))) return ''
  return 'Its agent is starting.'
}

/** The card: who wrote it, the task's name, its scope folded with Show all when long, its Settings folded away, and
 *  under it whether the agent has it. `space` names the Assistant that wrote it; `state` is its delivery. */
export function TaskBriefCard({ task, state, space }: { task: Task; state: BriefState; space?: string }) {
  const { scope, settings } = briefOf(task)
  const [all, setAll] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [long, setLong] = useState(() => looksLong(scope))
  const body = useRef<HTMLDivElement>(null)
  // long: its words run past the clipped height (measured, so a short brief never offers Show all)
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the scope changes, not only on a toggle
  useLayoutEffect(() => {
    const el = body.current
    if (el && !all) setLong(el.scrollHeight > el.clientHeight + 1)
  }, [scope, all])
  return (
    <div data-task-brief={task.id} className="mx-auto w-full max-w-read px-5 pt-4 phone:px-4">
      <div className="mb-1 text-[0.75rem] text-fg3 phone:text-[0.8125rem]">{briefFrom(space)}</div>
      <div className="rounded-box bg-bubble px-3.5 py-2.5 shadow-[inset_0_0_0_1px_var(--line2)] phone:px-4 phone:py-3">
        <p className="m-0 font-semibold">{task.name}</p>
        <div
          ref={body}
          className={clsx('mt-1 whitespace-pre-wrap wrap-anywhere text-pretty', !all && 'max-h-36 overflow-hidden', !all && long && '[mask-image:linear-gradient(#000_50%,transparent)]')}
        >
          {scope}
        </div>
        {long || all ? (
          <button
            type="button"
            aria-expanded={all}
            onClick={() => setAll(!all)}
            className="relative mt-1 flex items-center gap-1 text-[0.8125rem] font-medium text-fg2 after:absolute after:-inset-x-2 after:-inset-y-2.5 hover:text-fg phone:text-[0.9375rem]"
          >
            {all ? 'Show less' : 'Show all'}
            <DownIcon className={clsx('size-4', all && 'rotate-180')} />
          </button>
        ) : null}
        {settings.length ? (
          <>
            <button
              type="button"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen(!settingsOpen)}
              className="relative mt-1 flex items-center gap-1 text-[0.8125rem] font-medium text-fg2 after:absolute after:-inset-x-2 after:-inset-y-2.5 hover:text-fg phone:text-[0.9375rem]"
            >
              <DownIcon className={clsx('size-4', !settingsOpen && '-rotate-90')} />
              Settings
            </button>
            {settingsOpen ? (
              <ul className="m-0 mt-1 list-none p-0 text-[0.8125rem]/5 text-fg2 phone:text-[0.9375rem]/6">
                {settings.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : null}
      </div>
      <div className="mt-1 text-right text-[0.75rem] text-fg3 phone:text-[0.8125rem]" role="status">
        {deliveryWord(state)}
      </div>
    </div>
  )
}

/** the words waiting on you or on time, under the brief: a clock and one quiet line, never a message */
export function StartWords({ task, chat }: { task: Task; chat: Chat | undefined }) {
  const words = startWords(task, chat)
  if (!words) return null
  return (
    <div role="status" className="mx-auto mt-2 flex w-full max-w-read items-center gap-1.5 px-5 text-[0.8125rem] text-fg2 phone:px-4">
      <ClockIcon className={clsx(ic, 'size-4 shrink-0')} />
      <span>{words}</span>
    </div>
  )
}
