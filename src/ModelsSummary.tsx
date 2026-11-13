// Settings → Models → Summary (models-summary.ts), under the table: the warnings first (each with its fix in words, and
// a button into the cell that changes it where a setting does; Hide keeps it away for this browser session), then where
// the work runs per provider and per model: what is configured and what runs and waits now, the tokens and calls of the
// last 5 h, 24 h and 7 d (pi's cost is an estimate), the run-outs and whether it is out now, the share of the tokens of
// a day and of a week, and the quota a read of the provider gave (—: none read yet). A phone shows one card per provider.
import clsx from 'clsx'
import { Fragment, useState, type ReactNode } from 'react'
import type { ModelsSummary as Summary, QuotaFigure, SummaryConfigured, SummaryNow, SummaryProvider, SummaryRow, SummaryRunOuts, SummaryUsage, SummaryWarning } from '@shared/types.ts'
import { Ghost, Small } from './ui.tsx'

/** the warnings hidden in this browser session (sessionStorage: gone when the tab closes) */
const HIDDEN = 'models-summary:hidden'

/** tokens in words: 1.2M, 340k, 980 */
export const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`)
const percent = (x: number) => `${Math.round(x * 100)}%`
const when = (at: number) => new Date(at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function readHidden(): string[] {
  try {
    return (JSON.parse(sessionStorage.getItem(HIDDEN) ?? '[]') as unknown[]).filter((x): x is string => typeof x === 'string')
  } catch {
    // coverage-exempt: a browser that keeps no session storage (a private window) shows every warning again
    return []
  }
}

/** what a row is configured as, in words, with the roles and the spaces it counts in as a tooltip */
export function configuredWords(c: SummaryConfigured) {
  const slots = c.primary + c.backup
  if (!slots) return { words: '—', title: 'Not configured in any space' }
  const roles = Object.entries(c.roles).map(([r, n]) => `${r} ${n}`).join(' · ')
  const spaces = Object.entries(c.spaces).map(([s, n]) => `${s} ${n}`).join(' · ')
  return {
    words: `${plural(c.primary, 'primary', 'primary')}${c.backup ? `, ${c.backup} ${c.backup === 1 ? 'backup' : 'backups'}` : ''}`,
    title: `Roles: ${roles}. Spaces: ${spaces}.`,
  }
}

/** what runs and waits on a row now, in words */
export function nowWords(n: SummaryNow): string {
  const parts = [
    n.agents ? `${n.agents} live${n.working ? `, ${n.working} working` : ''}` : '',
    n.starts ? `${n.starts} to start` : '',
    n.reviews ? `${n.reviews} to review` : '',
  ].filter(Boolean)
  return parts.join(' · ') || '—'
}

/** the run-outs of a row, in words: how many in the week, the last one, and whether it is out now */
export function runWords(r: SummaryRunOuts) {
  const count = r.count7d ? plural(r.count7d, 'run-out in 7 d', 'run-outs in 7 d') : 'none in 7 d'
  const last = r.last ? `last ${when(r.last.at)}${r.last.reset ? `, ${r.last.reset}` : ''}` : ''
  const out = r.out ? (r.until !== undefined ? `Out until ${when(r.until)}` : 'Out now') : ''
  return { count, last, out }
}

/** a quota figure in words: each window's share used or count against its cap, and an estimate's word; — when none. A
 *  window that has refilled since its read (its reset is past) says nothing of now, so it is left out (as upstream's
 *  plan limits leave out a refilled window) */
export function quotaWords(q: QuotaFigure | undefined, now: number): string {
  if (!q) return '—'
  const parts = q.windows.filter((w) => w.resetAt === undefined || w.resetAt > now).map((w) => {
    const used = w.usedPct !== undefined ? `${Math.round(w.usedPct)}% used` : w.used !== undefined && w.cap !== undefined ? `${tokens(w.used)} of ${tokens(w.cap)}` : w.used !== undefined ? `${tokens(w.used)} used` : ''
    return [w.name, used].filter(Boolean).join(' ')
  })
  return [...parts, q.estimate ? 'estimate' : ''].filter(Boolean).join(' · ') || '—'
}

/** a window's usage in words: its tokens, then its calls and pi's cost as an estimate (sub) */
function usageWords(u: SummaryUsage) {
  if (!u.calls) return { main: '—', sub: '' }
  return {
    main: tokens(u.tokens),
    sub: [plural(u.calls, 'call', 'calls'), u.cost !== undefined ? `≈ $${u.cost.toFixed(2)} estimate` : ''].filter(Boolean).join(' · '),
  }
}

/** a provider's share of the tokens in a day and in a week: a thin bar each, and the share in words */
function Shares({ row }: { row: SummaryProvider }) {
  const lines = [
    { k: '24 h', v: row.share.h24 },
    { k: '7 d', v: row.share.d7 },
  ].filter((x): x is { k: string; v: number } => x.v !== undefined)
  if (!lines.length) return null // no tokens in the week: no bar
  return (
    <span className="mt-1 flex flex-col gap-1">
      {lines.map((x) => (
        <span key={x.k} className="flex items-center gap-2 text-[0.75rem] text-fg3 tabular-nums">
          <span className="w-8 shrink-0">{x.k}</span>
          <span role="img" aria-label={`${x.k}: ${percent(x.v)} of the tokens`} className="relative h-1.5 w-20 shrink overflow-hidden rounded-full bg-line2">
            <span className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${Math.max(1, Math.round(x.v * 100))}%` }} />
          </span>
          <span>{percent(x.v)}</span>
        </span>
      ))}
    </span>
  )
}

/** the warnings still shown, each with its fix and its button (a Change into the cell, or a Hide for this session) */
function Warnings({ list, go }: { list: SummaryWarning[]; go: (row: string, slot: string) => void }) {
  const [hidden, setHidden] = useState<string[]>(readHidden)
  const shown = list.filter((w) => !hidden.includes(w.id))
  if (!shown.length) return null
  const hide = (id: string) => {
    const next = [...hidden, id]
    setHidden(next)
    try {
      sessionStorage.setItem(HIDDEN, JSON.stringify(next))
    } catch {
      // coverage-exempt: a browser that keeps no session storage hides it until the screen is read again
    }
  }
  return (
    <section aria-label="Warnings" className="flex flex-col gap-2">
      <h3 className="font-medium">Warnings</h3>
      <ul className="flex flex-col gap-2">
        {shown.map((w) => (
          <li key={w.id} className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-box bg-bg px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--line)] dark:bg-bubble">
            <span aria-hidden="true" className={clsx('mt-1.5 size-2 shrink-0 rounded-full', w.level === 'risk' ? 'bg-need' : 'bg-fg3')} />
            <div className="flex min-w-56 flex-1 flex-col gap-0.5">
              <p className={clsx('text-pretty', w.level === 'risk' && 'text-need-fg')}>{w.words}</p>
              {w.fix ? <Small className="text-pretty">{w.fix}</Small> : null}
            </div>
            <div className="flex items-center gap-1.5">
              {w.go ? (
                <Ghost onClick={() => go(w.go!.row, w.go!.slot)} className="text-accent">
                  Change…
                </Ghost>
              ) : null}
              <Ghost onClick={() => hide(w.id)} aria-label={`Hide for this session: ${w.words}`}>
                Hide
              </Ghost>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** the summary: the warnings, then the providers and their models */
export default function ModelsSummary({ s, phone, go, extra }: { s: Summary; phone: boolean; go: (row: string, slot: string) => void; extra?: ReactNode }) {
  return (
    <section aria-label="Summary" className="flex w-full flex-col gap-4 pt-2">
      <h2 className="font-medium">Summary</h2>
      <Warnings list={s.warnings} go={go} />
      {extra}
      {s.backfilled === undefined ? <Small className="text-pretty">Reading the logs once from their start: the numbers grow until it is done.</Small> : null}
      {s.providers.length ? (phone ? <Cards providers={s.providers} now={s.at} /> : <Table providers={s.providers} now={s.at} />) : <Small className="text-pretty">Nothing configured, run or used yet.</Small>}
      <Small className="text-pretty">
        Usage is read from the logs of this machine's agents, and kept 35 days. Cost is pi's own estimate, not a bill. Quota shows once a read of the provider has given it.
      </Small>
    </section>
  )
}

/** the table on a desktop: a provider's row, then its models under it */
function Table({ providers, now }: { providers: SummaryProvider[]; now: number }) {
  const head = ['Provider', 'Configured, and now', 'Used', 'Run-outs', 'Quota']
  return (
    <div className="max-w-full overflow-x-auto overscroll-contain">
      <table aria-label="Providers and models" className="w-full min-w-[44rem] border-separate border-spacing-0 text-[0.8125rem]">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col" className="pr-4 pb-2 text-left font-medium text-fg3">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {providers.map((p) => (
            <Fragment key={p.provider}>
              <Line name={p.name} local={p.local} row={p} quota={p.quota} now={now} shares={<Shares row={p} />} bold />
              {p.models.map((m) => (
                <Line key={m.key} name={m.label} row={m} now={now} indent />
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** the three windows of a row's usage, one line each: the tokens, the calls, and pi's cost as an estimate */
function UsedLines({ row }: { row: SummaryRow }) {
  const lines: [string, SummaryUsage][] = [
    ['5 h', row.usage.h5],
    ['24 h', row.usage.h24],
    ['7 d', row.usage.d7],
  ]
  return (
    <dl className="grid grid-cols-[2.25rem_auto] gap-x-2 whitespace-nowrap tabular-nums">
      {lines.map(([k, u]) => (
        <Fragment key={k}>
          <dt className="text-fg3">{k}</dt>
          <dd className={u.calls ? 'text-fg' : 'text-fg3'}>
            {u.calls ? [`${tokens(u.tokens)} tokens`, plural(u.calls, 'call', 'calls'), u.cost !== undefined ? `≈ $${u.cost.toFixed(2)} est.` : ''].filter(Boolean).join(' · ') : '—'}
          </dd>
        </Fragment>
      ))}
    </dl>
  )
}

/** one table row: a provider or a model, its numbers in the columns */
function Line({ name, local, row, quota, now, shares, bold, indent }: { name: string; local?: boolean; row: SummaryRow; quota?: QuotaFigure; now: number; shares?: ReactNode; bold?: boolean; indent?: boolean }) {
  const conf = configuredWords(row.configured)
  const runs = runWords(row.runOuts)
  return (
    <tr className={clsx(bold && 'border-t border-line')}>
      <th scope="row" className={clsx('max-w-56 py-2 pr-4 text-left align-top font-normal', indent && 'pl-5')}>
        <span className={clsx('block truncate', bold ? 'font-medium' : 'text-fg2')} title={name}>
          {name}
          {local ? <span className="ml-1.5 text-fg3">local</span> : null}
        </span>
        {shares}
      </th>
      <td className="pr-4 py-2 align-top" title={conf.title}>
        <span className="block whitespace-nowrap text-fg2">{conf.words}</span>
        <span className="block text-[0.75rem] whitespace-nowrap text-fg3">{nowWords(row.now)}</span>
      </td>
      <td className="pr-4 py-2 align-top">
        <UsedLines row={row} />
      </td>
      <td className="pr-4 py-2 align-top">
        <RunOutWords runs={runs} />
      </td>
      <td className="py-2 align-top text-fg2">
        <QuotaCell quota={quota} now={now} />
      </td>
    </tr>
  )
}

function RunOutWords({ runs }: { runs: ReturnType<typeof runWords> }) {
  return (
    <span className="flex flex-col whitespace-nowrap">
      <span className="text-fg2">{runs.count}</span>
      {runs.last ? <span className="text-[0.75rem] text-fg3">{runs.last}</span> : null}
      {runs.out ? <span className="font-medium text-need-fg">{runs.out}</span> : null}
    </span>
  )
}

/** a provider's quota: its windows when a read gave them, a dash until then (4b fills it) */
function QuotaCell({ quota, now }: { quota?: QuotaFigure; now: number }) {
  return <span className={clsx(!quota && 'text-fg3')}>{quotaWords(quota, now)}</span>
}

/** the phone: one card per provider, its models under it */
function Cards({ providers, now }: { providers: SummaryProvider[]; now: number }) {
  return (
    <ul className="flex flex-col gap-3">
      {providers.map((p) => {
        const conf = configuredWords(p.configured)
        const runs = runWords(p.runOuts)
        return (
          <li key={p.provider} className="flex flex-col gap-2 rounded-box bg-bg px-4 py-3 shadow-[inset_0_0_0_1px_var(--line)] dark:bg-bubble">
            <div className="flex items-baseline justify-between gap-3">
              <h4 className="min-w-0 truncate font-medium">
                {p.name}
                {p.local ? <span className="ml-1.5 font-normal text-fg3">local</span> : null}
              </h4>
              {p.share.h24 !== undefined ? <Small>{percent(p.share.h24)} of today's tokens</Small> : null}
            </div>
            <Shares row={p} />
            <dl className="flex flex-col gap-1.5 text-[0.8125rem] phone:text-[0.9375rem]">
              <Pair k="Configured" v={conf.words} title={conf.title} />
              <Pair k="Now" v={nowWords(p.now)} />
              <Pair k="Last 5 h" v={usageWords(p.usage.h5).main} sub={usageWords(p.usage.h5).sub} />
              <Pair k="Last 24 h" v={usageWords(p.usage.h24).main} sub={usageWords(p.usage.h24).sub} />
              <Pair k="Last 7 d" v={usageWords(p.usage.d7).main} sub={usageWords(p.usage.d7).sub} />
              <Pair k="Run-outs" v={runs.count} sub={[runs.last, runs.out].filter(Boolean).join(' · ')} need={!!runs.out} />
              <Pair k="Quota" v={quotaWords(p.quota, now)} muted={!p.quota} />
            </dl>
            {p.models.length ? (
              <ul className="flex flex-col gap-1.5 border-t border-line pt-2">
                {p.models.map((m) => (
                  <li key={m.key} className="flex items-baseline justify-between gap-3 text-[0.8125rem] phone:text-[0.9375rem]">
                    <span className="min-w-0 truncate text-fg2">{m.label}</span>
                    <span className="shrink-0 text-right tabular-nums">{tokens(m.usage.d7.tokens)} in 7 d</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

function Pair({ k, v, sub, title, need, muted }: { k: string; v: string; sub?: string; title?: string; need?: boolean; muted?: boolean }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3">
      <dt className="text-fg3">{k}</dt>
      <dd className={clsx('min-w-0 tabular-nums', muted ? 'text-fg3' : 'text-fg')} title={title}>
        <span className="block">{v}</span>
        {sub ? <span className={clsx('block text-[0.75rem] text-fg3', need && 'font-medium text-need-fg!')}>{sub}</span> : null}
      </dd>
    </div>
  )
}
