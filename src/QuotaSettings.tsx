// Settings → Models → Quotas: the switch of each provider's quota read and the share at which Shepherdr warns. They are
// Settings' Quotas section (server settings.ts), drawn here above the summary instead of as a page of their own; each
// write is the same setting action Settings uses, Everywhere, and a refusal says why under its row.
import { useState } from 'react'
import type { SettingRow } from '@shared/types.ts'
import { act, useSnap } from './kernel.ts'
import { Control, QUOTAS, rowLook } from './Settings.tsx'
import { readingWords } from './ModelsSummary.tsx'
import { Ghost, Small } from './ui.tsx'

export default function QuotaSettings({ phone }: { phone: boolean }) {
  const snap = useSnap()
  const rows = snap?.settings.find((x) => x.name === QUOTAS)?.rows ?? []
  const [refused, setRefused] = useState<Record<string, string>>({})
  // Refresh quotas: what started, or why nothing did (each provider at most once a minute); the reads land on the summary
  const [note, setNote] = useState('')
  const refresh = async () => {
    const r = (await act({ type: 'quota-refresh' }).catch((e: Error) => ({ ok: false, error: e.message }))) as { ok?: boolean; started?: string[]; error?: string }
    setNote(r?.ok ? readingWords(r.started ?? []) : (r?.error ?? "That didn't go through."))
  }
  const set = async (row: SettingRow, value: string) => {
    const r = (await act({ type: 'setting', key: row.key, value, place: 'all' }).catch((e: Error) => ({ ok: false, error: e.message }))) as { ok?: boolean; error?: string }
    setRefused((x) => ({ ...x, [row.key]: r?.ok === false ? (r.error ?? "That didn't go through.") : '' }))
  }
  return (
    <section aria-label="Quotas" className="flex w-full flex-col gap-1">
      <h3 className="font-medium">Quotas</h3>
      <dl className="flex flex-col">
        {rows.map((row) => (
          <div key={row.key} className={rowLook(phone)}>
            <dt className="flex min-w-0 flex-col">
              {row.label}
              {row.hint ? <Small className="text-pretty">{row.hint}</Small> : null}
              {refused[row.key] ? (
                <Small role="status" className="text-pretty text-need-fg!">
                  {refused[row.key]}
                </Small>
              ) : null}
            </dt>
            <dd className="flex min-w-0 justify-end">
              <Control row={row} phone={phone} set={(v) => void set(row, v)} edit={() => undefined} />
            </dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
        <Ghost onClick={() => void refresh()} className="text-accent">
          Refresh quotas
        </Ghost>
        {note ? (
          <Small role="status" className="text-pretty">
            {note}
          </Small>
        ) : null}
      </div>
    </section>
  )
}
