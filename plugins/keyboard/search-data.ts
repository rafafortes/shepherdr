// Search only the view model already shared with the screen. No files, tool output, artifact HTML or secret store.
import type { Chat, SettingRow, SettingSection, Snapshot } from '../../shared/types.ts'
import { findIn, messageText } from '../chat/days.ts'

export type SearchScope = { kind: 'all' } | { kind: 'machine' | 'space' | 'chat'; id: string }
export type SearchKind = 'Spaces' | 'Tasks' | 'Messages' | 'Artifacts' | 'Settings'
/** Only the newest messages of a chat are scanned; older ones stay reachable by jumping to the chat itself. */
export const SEARCH_MESSAGE_WINDOW = 500
/** No more than this many hits of one kind are built before sorting, so a wide scope stays bounded. */
export const SEARCH_HITS_PER_KIND = 200
export interface SearchHit {
  key: string
  kind: SearchKind
  label: string
  context: string
  place: string
  task?: string
  chat?: string
  message?: string
  artifact?: string
  /** a settings hit opens its page (section name) at its level */
  setting?: string
  level?: string
  at: number
}

export function searchChats(snap: Snapshot, scope: SearchScope) {
  const places = snap.places.filter(p => scope.kind === 'all' || scope.kind === 'chat' || (scope.kind === 'space' ? p.id === scope.id : p.machine === scope.id))
  const chats = places.map(p => ({ key: p.chat, place: p.id, label: p.name }))
  for (const t of snap.tasks) {
    if (!places.some(p => p.id === t.place)) continue
    // Completed agents still have a readable chat even when their running agent record is gone.
    chats.push({ key: t.agent?.chat ?? `${t.id}/Agent`, place: t.place, label: `${t.id} · ${t.name}` })
  }
  return [...new Map(chats.filter(c => scope.kind !== 'chat' || c.key === scope.id).map(c => [c.key, c])).values()]
}

const words = (q: string, ...s: (string | undefined)[]) => q.toLowerCase().trim().split(/\s+/).every(w => s.some(v => v?.toLowerCase().includes(w)))

/** the Settings page a row opens: the few sections without a page of their own are drawn on another one */
const settingPage = (section: SettingSection, row: SettingRow) =>
  section.name === 'Quotas' ? 'Models'
  : section.name === 'Alerts and voice' ? (row.key.startsWith('voice.') ? 'Voice' : 'Notifications')
  : section.name === 'Notify' || section.name === 'Alert command' ? 'Notifications'
  : section.name

/** A chat in scope holds more messages than the search window, so its older ones were not scanned. */
export function searchCapped(sources: ReturnType<typeof searchChats>, chats: Record<string, Chat>) {
  return sources.some(c => (chats[c.key]?.messages.length ?? 0) > SEARCH_MESSAGE_WINDOW)
}

export function searchResults(snap: Snapshot, scope: SearchScope, q: string, chats: Record<string, Chat>): SearchHit[] {
  const sources = searchChats(snap, scope)
  const inPlace = (id: string) => scope.kind === 'all' || (scope.kind === 'space' && id === scope.id) || (scope.kind === 'machine' && snap.places.some(p => p.id === id && p.machine === scope.id))
  const context = (id: string) => {
    const p = snap.places.find(p => p.id === id)
    return `${p?.name ?? id} · ${snap.machines.find(m => m.machine === p?.machine)?.name ?? p?.machine ?? ''}`
  }
  // Settings defaults live at a level: Everywhere, a machine or a space (a chat reads its place's space). The scope
  // picks the level, so a space's override is found there and not mixed into Everywhere's rows.
  const level = scope.kind === 'machine' ? `m:${scope.id}` : scope.kind === 'space' ? scope.id : scope.kind === 'chat' ? sources.find(c => c.key === scope.id)?.place ?? 'all' : 'all'
  const levelName = (l: string) => l === 'all' ? 'Everywhere' : snap.places.find(p => p.id === l)?.name ?? snap.machines.find(m => m.machine === l.slice(2))?.name ?? l
  const hits: SearchHit[] = []
  const counts: Record<SearchKind, number> = { Spaces: 0, Tasks: 0, Messages: 0, Artifacts: 0, Settings: 0 }
  const add = (hit: SearchHit) => {
    if (counts[hit.kind] >= SEARCH_HITS_PER_KIND) return
    counts[hit.kind]++
    hits.push(hit)
  }
  for (const p of snap.places) if (inPlace(p.id) && words(q, p.name, context(p.id))) add({ key: `p:${p.id}`, kind: 'Spaces', label: p.name, context: context(p.id), place: p.id, at: 0 })
  for (const t of snap.tasks) if ((inPlace(t.place) || (scope.kind === 'chat' && sources.some(c => c.key === (t.agent?.chat ?? `${t.id}/Agent`)))) && (q.trim() || !t.archived) && words(q, t.id, t.name, t.sub, t.desc, context(t.place), t.report?.msg)) add({ key: `t:${t.id}`, kind: 'Tasks', label: `${t.id} · ${t.name}`, context: `${t.archived ? 'Archived · ' : ''}${context(t.place)}`, place: t.place, task: t.id, at: Math.max(t.doneAt ?? 0, chats[t.agent?.chat ?? `${t.id}/Agent`]?.messages.reduce((at, m) => Math.max(at, m.at ?? 0), 0) ?? 0) })
  for (const a of snap.artifacts ?? []) if ((inPlace(a.place) || (scope.kind === 'chat' && (a.chats?.includes(scope.id) || chats[scope.id]?.messages.some(m => m.artifact?.id === a.id)))) && words(q, a.title, a.id, a.by)) add({ key: `a:${a.id}`, kind: 'Artifacts', label: a.title, context: `${context(a.place)} · ${a.by} · v${a.v}`, place: a.place, artifact: a.id, at: a.at })
  // An empty query lists Spaces, Tasks and Artifacts only: their own `at` is enough, and no chat or settings load.
  if (q.trim()) for (const c of sources) {
    const all = chats[c.key]?.messages ?? []
    const msgs = all.length > SEARCH_MESSAGE_WINDOW ? all.slice(-SEARCH_MESSAGE_WINDOW) : all
    const found = new Set(findIn(msgs, q))
    for (const m of msgs) {
      if (m.waiting || !found.has(m.id)) continue
      add({ key: `m:${c.key}:${m.id}`, kind: 'Messages', label: searchExcerpt(messageText(m), q), context: `${c.label} · ${context(c.place)}`, place: c.place, chat: c.key, message: m.id, at: m.at ?? 0 })
    }
  }
  // Settings are matched only by their words and where they open, never by their value: a value can hold a private
  // instruction or a secret. With no query 'Recent items' stays as it was, so all 66 rows do not flood the sheet.
  if (q.trim()) for (const section of snap.settings ?? []) {
    if (section.level !== level) continue
    for (const row of section.rows) {
      if (!words(q, row.label, row.key, row.hint, row.group, row.sub)) continue
      const page = settingPage(section, row)
      add({
        key: `s:${section.level}:${section.name}:${row.key}`,
        kind: 'Settings',
        label: row.label,
        context: `${page}${row.group ? ` · ${row.group}` : ''} · ${levelName(section.level)}`,
        place: '',
        setting: page,
        level: section.level,
        at: 0,
      })
    }
  }
  return hits.sort((a, b) => b.at - a.at)
}

/** Put the actual matching words in view, even in a long folded reply. */
export function searchExcerpt(text: string, q: string) {
  const match = q.trim() ? text.toLowerCase().indexOf(q.trim().toLowerCase()) : 0
  const start = Math.max(0, match - 70)
  return `${start ? '…' : ''}${text.slice(start, start + 240)}${text.length > start + 240 ? '…' : ''}`
}
