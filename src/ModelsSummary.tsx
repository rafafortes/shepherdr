// Settings → Models → Summary (models-summary.ts), under the table: the warnings first (each with its fix in words, and
// a button into the cell that changes it where a setting does; Hide keeps it away for this browser session), then where
// the work runs per provider and per model: what is configured and what runs and waits now, the tokens and calls of the
// last 5 h, 24 h and 7 d (pi's cost is an estimate), the run-outs and whether it is out now, the share of the tokens of
// a day and of a week, and the quota: each window with its bar, when it refills, where its figure came from and how old it
// is, a failed read's reason, and the hint that asks for a key (QuotaView). A phone shows one card per provider.
import clsx from 'clsx'
import { Fragment, useState, type ReactNode } from 'react'
import type { ModelsSummary as Summary, QuotaFigure, QuotaRead, QuotaWindow, SummaryConfigured, SummaryNow, SummaryProvider, SummaryRow, SummaryRunOuts, SummaryUsage, SummaryWarning } from '@shared/types.ts'
import { openPage } from './Settings.tsx'
import { ageWords, shareOf, tokens, windowWords } from '../shared/quota-words.ts'
import { harnessGroups, inHarness } from '../shared/harness.ts'
import { CapCell, type CapsText } from './CapCell.tsx'
import { Ghost, Small } from './ui.tsx'

/** the warnings hidden in this browser session (sessionStorage: gone when the tab closes) */
const HIDDEN = 'models-summary:hidden'

const percent = (x: number) => `${Math.round(x * 100)}%`
const when = (at: number) => new Date(at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function readHidden(): string[] {
  try {
    return (JSON.parse(sessionStorage.getItem(HIDDEN) ?? '[]') as unknown[]).filter((x): x is string => typeof x === 'string')
  } catch {
    // a browser that keeps no session storage (a private window) shows every warning again
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

/** the run-outs of a row, in words: how many in the week, the last one, and whether it is out now (an idle row, with
 *  nothing in use, says a dash for the count) */
export function runWords(r: SummaryRunOuts, idle = false) {
  const count = r.count7d ? plural(r.count7d, 'run-out in 7 d', 'run-outs in 7 d') : idle ? '—' : 'none in 7 d'
  const last = r.last ? `last ${when(r.last.at)}${r.last.reset ? `, ${r.last.reset}` : ''}` : ''
  const out = r.out ? (r.until !== undefined ? `Out until ${when(r.until)}` : 'Out now') : ''
  return { count, last, out }
}

/** the provider's name in the Settings section that reads its quota (Refresh quotas says what it reads) */
const READING: Record<string, string> = { claude: 'Claude Code', 'pi.commandcode': inHarness('pi', 'Command Code') }
export const readingWords = (started: string[]) => `Reading ${started.map((p) => READING[p] ?? p).join(' and ')}…`

/** Settings → Secrets (Everywhere's page): where a quota's key is added, opened from the hint that asks for it */
const openSecrets = () => openPage('Secrets', 'all')

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
      // a browser that keeps no session storage hides it until the screen is read again
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

/** the summary: the warnings, then the providers and their models. `capOpen`: the cap cell open (its id, cap|<pattern>), which a
 *  warning's Change… opens too */
export default function ModelsSummary({ s, phone, go, extra, capOpen, onCapOpen }: { s: Summary; phone: boolean; go: (row: string, slot: string) => void; extra?: ReactNode; capOpen: string | null; onCapOpen: (id: string | null) => void }) {
  const caps: CapsText = s.caps
  const cap = { caps, open: capOpen, onOpen: onCapOpen }
  return (
    <section aria-label="Summary" className="flex w-full flex-col gap-4 pt-2">
      <h2 className="font-medium">Summary</h2>
      <Warnings list={s.warnings} go={go} />
      {extra}
      {s.backfilled === undefined ? <Small className="text-pretty">Reading the logs once from their start: the numbers grow until it is done.</Small> : null}
      {s.providers.length ? (phone ? <Cards providers={s.providers} now={s.at} cap={cap} /> : <Table providers={s.providers} now={s.at} cap={cap} />) : <Small className="text-pretty">Nothing configured, run or used yet.</Small>}
      <Small className="text-pretty">
        Usage is read from the logs of this machine's agents, and kept 35 days. Cost is pi's own estimate, not a bill. Quota is each provider's last read, or an estimate, as Quotas says.
      </Small>
    </section>
  )
}

/** what the cap cells share: this machine's and Everywhere's texts, and the one open cell */
interface CapState {
  caps: CapsText
  open: string | null
  onOpen: (id: string | null) => void
}

/** the providers nothing uses yet (no slot, agent, run, run-out in the week, or cap): a group under the table, its models
 *  and their cap cells in it, with no numbers. Closed on the summary; open where the caps are set (Limits) */
export function OtherProviders({ count, open, children }: { count: number; open: boolean; children: ReactNode }) {
  return (
    <details open={open} className="flex flex-col gap-2 pt-3">
      <summary className="cursor-pointer text-fg2 select-none">Other providers ({count})</summary>
      {children}
    </details>
  )
}

/** the table on a desktop: a provider's row, then its models under it; the providers nothing uses yet under Other providers */
function Table({ providers, now, cap }: { providers: SummaryProvider[]; now: number; cap: CapState }) {
  const used = providers.filter((p) => !p.idle)
  const idle = providers.filter((p) => p.idle)
  return (
    <div className="max-w-full overflow-x-auto overscroll-contain">
      <Grid label="Providers and models" providers={used} now={now} cap={cap} />
      {idle.length ? (
        <OtherProviders count={idle.length} open={false}>
          <Grid label="Other providers" providers={idle} now={now} cap={cap} idle />
        </OtherProviders>
      ) : null}
    </div>
  )
}

/** one table of providers and their models: the Provider column stays in view when the table is narrower than its content
 *  (a phone-sized window): sticky, opaque */
function Grid({ label, providers, now, cap, idle }: { label: string; providers: SummaryProvider[]; now: number; cap: CapState; idle?: boolean }) {
  const head = ['Provider', 'Quota', 'Run-outs', 'Used', 'Configured, and now']
  return (
    <table aria-label={label} className="w-full table-fixed border-separate border-spacing-0 text-[0.8125rem]">
      <colgroup>
        <col className="w-[22%]" />
        <col className="w-[30%]" />
        <col className="w-[13%]" />
        <col className="w-[16%]" />
        <col className="w-[19%]" />
      </colgroup>
      <thead>
        <tr>
          {head.map((h) => (
            <th key={h} scope="col" className={clsx('pr-4 pb-2 text-left font-medium text-fg3', h === 'Provider' && 'sticky left-0 z-[1] bg-bg dark:bg-bubble')}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {harnessGroups(providers).map((g) => (
          <Fragment key={g.harness}>
            {g.single ? null : <HarnessRow name={g.name} cols={5} />}
            {g.list.map((p) => (
              <Fragment key={p.provider}>
                <Line name={p.name} harness={p.harnessName} local={p.local} row={p} quota={p.quota} read={p.quotaRead} now={now} shares={<Shares row={p} />} bold depth={g.single ? 0 : 1} cap={{ ...cap, pattern: p.provider }} idle={idle} />
                {p.models.map((m) => (
                  <Line key={m.key} name={m.label} title={m.key} row={m} now={now} depth={g.single ? 1 : 2} cap={{ ...cap, pattern: m.key }} idle={idle} />
                ))}
              </Fragment>
            ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  )
}

/** the three windows of a row's usage, one compact line each ("5 h 237k · 12": tokens, then calls); the words in full,
 *  with pi's cost as an estimate, are the line's tooltip */
function UsedLines({ row }: { row: SummaryRow }) {
  const lines: [string, SummaryUsage][] = [
    ['5 h', row.usage.h5],
    ['24 h', row.usage.h24],
    ['7 d', row.usage.d7],
  ]
  return (
    <ul className="flex flex-col whitespace-nowrap tabular-nums">
      {lines.map(([k, u]) => (
        <li
          key={k}
          className={u.calls ? 'text-fg' : 'text-fg3'}
          title={u.calls ? [`${k}: ${tokens(u.tokens)} tokens`, plural(u.calls, 'call', 'calls'), u.cost !== undefined ? `≈ $${u.cost.toFixed(2)} est.` : ''].filter(Boolean).join(' · ') : `${k}: no calls`}
        >
          <span className="text-fg3">{k}</span> {u.calls ? `${tokens(u.tokens)} · ${u.calls}` : '—'}
        </li>
      ))}
    </ul>
  )
}

/** the left indent of a row's name by its depth under the harness headings: 0 (a single-account CLI's provider, its own row), 1 (a
 *  provider under a heading, or a model of a single-account CLI), 2 (a model under a heading) */
const INDENT = ['', 'pl-5', 'pl-10']

/** a harness's heading row in a table: its name, across the table's columns */
export function HarnessRow({ name, cols }: { name: string; cols: number }) {
  return (
    <tr>
      <th scope="row" colSpan={cols} className="sticky left-0 z-[1] bg-bg pt-3 pb-1 text-left font-medium text-fg2 dark:bg-bubble">
        {name}
      </th>
    </tr>
  )
}

/** one table row: a provider or a model, its numbers in the columns (`harness`: the provider's harness, for its cap's editor) */
function Line({ name, harness, title, local, row, quota, read, now, shares, bold, depth = 0, cap, idle }: { name: string; harness?: string; title?: string; local?: boolean; row: SummaryRow; quota?: QuotaFigure; read?: QuotaRead; now: number; shares?: ReactNode; bold?: boolean; depth?: number; cap: CapState & { pattern: string }; idle?: boolean }) {
  const conf = configuredWords(row.configured)
  const runs = runWords(row.runOuts, idle)
  return (
    <tr className={clsx(bold && 'border-t border-line')}>
      <th scope="row" className={clsx('sticky left-0 z-[1] bg-bg py-2 pr-4 text-left align-top font-normal dark:bg-bubble', INDENT[depth])}>
        <span className={clsx('block truncate', bold ? 'font-medium' : 'text-fg2')} title={title ?? name}>
          {name}
          {local ? <span className="ml-1.5 text-fg3">local</span> : null}
        </span>
        {shares}
      </th>
      <td className="py-2 pr-4 align-top text-fg2">
        <QuotaView quota={quota} read={read} now={now} />
      </td>
      <td className="py-2 pr-4 align-top">
        <RunOutWords runs={runs} />
      </td>
      <td className="py-2 pr-4 align-top">
        <UsedLines row={row} />
      </td>
      <td className="py-2 align-top" title={conf.title}>
        <span className="block whitespace-nowrap text-fg2">{conf.words}</span>
        <span className="block truncate text-[0.75rem] text-fg3">{nowWords(row.now)}</span>
        <span className="mt-0.5 block text-[0.75rem]">
          <CapCell name={name} harness={harness} pattern={cap.pattern} atOnce={row.atOnce} caps={cap.caps} phone={false} openId={cap.open} onOpen={cap.onOpen} />
        </span>
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

/** one window: its name and its share used (or its count against its cap, or what is left), a thin bar, when it refills
 *  (an estimate's window rolls), and an estimate's learned limits: what the window held when the provider ran out */
function WindowLine({ w, estimate }: { w: QuotaWindow; estimate: boolean }) {
  const share = shareOf(w)
  const main = windowWords(w)
  return (
    <div className="flex min-w-44 flex-col gap-0.5">
      <span className="flex items-baseline justify-between gap-2 whitespace-nowrap">
        <span className="flex items-center gap-1.5 text-fg">
          {w.name}
          {estimate ? <span className="rounded-full bg-line2 px-1.5 text-[0.6875rem] leading-4 text-fg2">estimate</span> : null}
        </span>
        <span className="tabular-nums text-fg">{main}</span>
      </span>
      {share !== undefined ? (
        <span role="img" aria-label={`${w.name}: ${Math.round(share)}% used`} className="relative block h-1.5 w-full overflow-hidden rounded-full bg-line2">
          <span className={clsx('absolute inset-y-0 left-0 rounded-full', share >= 100 ? 'bg-need' : 'bg-accent')} style={{ width: `${Math.min(100, Math.max(1, Math.round(share)))}%` }} />
        </span>
      ) : null}
      {w.resetAt !== undefined ? <span className="text-[0.75rem] text-fg3">refills {when(w.resetAt)}</span> : estimate ? <span className="text-[0.75rem] text-fg3">rolling: drains as calls leave the window</span> : null}
      {w.learned?.slice(0, 3).map((l) => (
        <span key={l.at} className="text-[0.75rem] text-fg3 tabular-nums">
          ran out at ~{tokens(l.tokens)} tokens{l.cost !== undefined ? ` · ≈ $${l.cost.toFixed(2)} est.` : ''} in {w.name} on {when(l.at)}
        </span>
      ))}
    </div>
  )
}

/** a provider's quota: each window that has not refilled, where the figure came from and how old it is, a failed read's
 *  reason (the figure stays the last good one), and a hint with a way to Secrets where the key is what it asks for. A
 *  switch that is off says so; a provider with no read and no figure shows a dash */
export function QuotaView({ quota, read, now }: { quota?: QuotaFigure; read?: QuotaRead; now: number }) {
  const off = read !== undefined && !read.on
  if (!quota && !read?.failed && !read?.hint) return <span className="text-fg3">{off ? 'Off' : '—'}</span>
  const windows = (quota?.windows ?? []).filter((w) => w.resetAt === undefined || w.resetAt > now)
  const source = quota ? (quota.estimate ? quota.source : `${quota.source}, read ${ageWords(quota.at, now)}`) : ''
  return (
    <div className="flex min-w-44 flex-col gap-2">
      {windows.map((w) => (
        <WindowLine key={w.name} w={w} estimate={!!quota?.estimate} />
      ))}
      {source ? <span className="text-[0.75rem] text-fg3">{source}</span> : null}
      {read?.failed ? (
        <span className="text-[0.75rem] text-pretty text-need-fg">
          Last read failed {ageWords(read.tried ?? now, now)}: {read.failed}
          {quota ? ` The figure is from ${ageWords(quota.at, now)}.` : ''}
        </span>
      ) : null}
      {read?.hint ? (
        <span className="text-[0.75rem] text-pretty text-fg2">
          {read.hint}
          {/Secrets/.test(read.hint) ? (
            <Ghost onClick={openSecrets} className="ml-1.5 text-accent">
              Open Secrets
            </Ghost>
          ) : null}
        </span>
      ) : null}
      {off ? <span className="text-[0.75rem] text-fg3">Read is off: its switch is under Quotas.</span> : null}
    </div>
  )
}

/** the phone: one card per provider, its models under it; the providers nothing uses yet under Other providers */
function Cards({ providers, now, cap }: { providers: SummaryProvider[]; now: number; cap: CapState }) {
  const used = providers.filter((p) => !p.idle)
  const idle = providers.filter((p) => p.idle)
  return (
    <>
      <CardList providers={used} now={now} cap={cap} />
      {idle.length ? (
        <OtherProviders count={idle.length} open={false}>
          <CardList providers={idle} now={now} cap={cap} idle />
        </OtherProviders>
      ) : null}
    </>
  )
}

/** the phone's cards, under a heading for each harness that runs several providers (a single-account CLI's card is its own) */
function CardList({ providers, now, cap, idle }: { providers: SummaryProvider[]; now: number; cap: CapState; idle?: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      {harnessGroups(providers).map((g) => (
        <Fragment key={g.harness}>
          {g.single ? null : <h3 className="px-1 font-medium text-fg2">{g.name}</h3>}
          <ul className="flex flex-col gap-3">
            {g.list.map((p) => (
              <Card key={p.provider} p={p} now={now} cap={cap} idle={idle} />
            ))}
          </ul>
        </Fragment>
      ))}
    </div>
  )
}

/** one provider's card on the phone: its numbers, its cap, and its models under it */
function Card({ p, now, cap, idle }: { p: SummaryProvider; now: number; cap: CapState; idle?: boolean }) {
  const conf = configuredWords(p.configured)
  const runs = runWords(p.runOuts, idle)
  return (
    <li className="flex flex-col gap-2 rounded-box bg-bg px-4 py-3 shadow-[inset_0_0_0_1px_var(--line)] dark:bg-bubble">
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="min-w-0 truncate font-medium">
          {p.name}
          {p.local ? <span className="ml-1.5 font-normal text-fg3">local</span> : null}
        </h4>
        {p.share.h24 !== undefined ? <Small>{percent(p.share.h24)} of today's tokens</Small> : null}
      </div>
      <Shares row={p} />
      <dl className="flex flex-col gap-1.5 text-[0.8125rem] phone:text-[0.9375rem]">
        <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3">
          <dt className="text-fg3">Quota</dt>
          <dd className="min-w-0">
            <QuotaView quota={p.quota} read={p.quotaRead} now={now} />
          </dd>
        </div>
        <Pair k="Run-outs" v={runs.count} sub={[runs.last, runs.out].filter(Boolean).join(' · ')} need={!!runs.out} />
        <Pair k="Last 5 h" v={usageWords(p.usage.h5).main} sub={usageWords(p.usage.h5).sub} />
        <Pair k="Last 24 h" v={usageWords(p.usage.h24).main} sub={usageWords(p.usage.h24).sub} />
        <Pair k="Last 7 d" v={usageWords(p.usage.d7).main} sub={usageWords(p.usage.d7).sub} />
        <Pair k="Configured" v={conf.words} title={conf.title} />
        <Pair k="Now" v={nowWords(p.now)} />
        <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3">
          <dt className="text-fg3">At once</dt>
          <dd className="min-w-0">
            <CapCell name={p.name} harness={p.harnessName} pattern={p.provider} atOnce={p.atOnce} caps={cap.caps} phone openId={cap.open} onOpen={cap.onOpen} />
          </dd>
        </div>
      </dl>
      {p.models.length ? (
        <ul className="flex flex-col gap-1.5 border-t border-line pt-2">
          {p.models.map((m) => (
            <li key={m.key} className="flex flex-col gap-1 text-[0.8125rem] phone:text-[0.9375rem]">
              <span className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-fg2">{m.label}</span>
                <span className="shrink-0 text-right tabular-nums">{idle ? '—' : `${tokens(m.usage.d7.tokens)} in 7 d`}</span>
              </span>
              <CapCell name={m.label} pattern={m.key} atOnce={m.atOnce} caps={cap.caps} phone openId={cap.open} onOpen={cap.onOpen} />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
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
