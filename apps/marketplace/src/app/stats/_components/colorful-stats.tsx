'use client'

/*
 * Stats body. Renders inside the page's <main>; Navigation + Footer
 * are owned by page.tsx so the marketplace nav stays present and the
 * dark theme background continues to inherit from the marketplace
 * tokens (var(--background), var(--card), var(--foreground)) instead
 * of an override.
 *
 * The page is client-only because of Recharts; data is fetched in
 * page.tsx and handed in via props so SEO + metadata stay correct.
 *
 * Layout follows the original ordering (counters - daily revenue -
 * 3-month projections - growth - returns - growth charts - financial
 * - rate history - rate table - tier - region - retail - carbon -
 * feeds). The Overview / Projections / Charts toggle filters which
 * sections render so the user can scope the view without scrolling.
 */

import { useState } from 'react'
import Link from 'next/link'
import {
  BarChart, Bar, AreaChart, Area, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://a2e-api.onrender.com'

export interface StatsSnapshot {
  timestamp: string
  totalNodesOnline: number
  totalOperatorsOnline: number
  totalRentalsLifetime: number
  totalComputeMinutesLifetime: number
  totalCo2GramsLifetime: number
  nodesByTier: Array<{ gpuTier: string; count: number }>
  regionDistribution: Array<{ region: string; count: number }>
  topPricesByTier: Array<{ gpuTier: string; ratePerHour: number; ratePerMinute: number }>
}

export interface AnalyticsSnapshot {
  timestamp: string
  dailyRevenue: Array<{ date: string; revenue: number }>
  monthlyPerformance: Array<{ month: string; revenue: number; payouts: number; buyerSpend: number }>
  projections: {
    daily:   { current: number; projected: number; growthPct: number }
    weekly:  { current: number; projected: number; growthPct: number }
    monthly: { current: number; projected: number; growthPct: number }
  }
  monthlyProjectionGrowth: Array<{ month: string; projected: number }>
  returnsVsCost: {
    totalCostBasis: number
    totalEarnings: number
    recoupRatio: number
    monthlyAvgEarnings: number
    breakEvenMonths: number | null
  }
  noderunnerGrowth: Array<{ date: string; total: number }>
  powerUsers: Array<{ date: string; count: number }>
  rateHistory: Record<string, Array<{ date: string; ratePerHour: number }>>
  rateTable: Array<{ gpuTier: string; current: number; median30d: number; min30d: number; max30d: number; deltaPct30d: number }>
}

// ---------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------

const fmtUsd = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n >= 100 ? 0 : 2 }).format(n)
const fmtUsdShort = (n: number) => {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (Math.abs(n) >= 10_000)    return `$${(n / 1_000).toFixed(1)}k`
  if (Math.abs(n) >= 1_000)     return `$${(n / 1_000).toFixed(2)}k`
  return fmtUsd(n)
}
const fmtMonth = (key: string) => {
  const [y, m] = key.split('-')
  if (!y || !m) return key
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}
const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

// ---------------------------------------------------------------------
// Palette - the only place this file overrides the marketplace tokens.
// Used as data colors on charts, never as page chrome.
// ---------------------------------------------------------------------

const COLORS = {
  green:  '#22c55e',
  cyan:   '#06b6d4',
  purple: '#8b5cf6',
  pink:   '#ec4899',
  orange: '#f97316',
  blue:   '#3b82f6',
  amber:  '#f59e0b',
  red:    '#ef4444',
  slate:  '#94a3b8',
}
const TIER_COLORS: Record<string, string> = {
  H100:  COLORS.green,
  H200:  COLORS.blue,
  B200:  COLORS.purple,
  B300:  COLORS.amber,
  GB300: COLORS.red,
  OTHER: COLORS.slate,
}

type Tab = 'overview' | 'projections' | 'charts'

// ---------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------

function BigStat({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="bg-background p-8">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-4">
        {label}
      </p>
      <p className="font-display text-5xl md:text-6xl text-foreground leading-none">
        {value}
      </p>
      <p className="font-mono text-xs text-muted-foreground mt-3">{unit}</p>
    </div>
  )
}

function SectionHeader({ eyebrow, caption }: { eyebrow: string; caption: string }) {
  return (
    <div className="mb-6">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-2">
        {eyebrow}
      </p>
      <p className="font-display text-2xl md:text-3xl text-foreground max-w-2xl leading-tight">
        {caption}
      </p>
    </div>
  )
}

function FeedLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-2 px-3 py-2 border border-border hover:border-foreground hover:bg-foreground/5 transition-colors text-foreground"
    >
      {label}
      <span aria-hidden>↗</span>
    </Link>
  )
}

function ChartTooltip({ active, payload, label, prefix = '', suffix = '' }: {
  active?: boolean
  payload?: Array<{ value: number; name: string; color?: string }>
  label?: string
  prefix?: string
  suffix?: string
}) {
  if (!active || !payload || payload.length === 0) return null
  return (
    <div className="rounded-md border border-border px-3 py-2 font-mono text-[11px] bg-card">
      {label && <p className="text-muted-foreground mb-1">{label}</p>}
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-sm" style={{ background: p.color }} />
          <span className="text-muted-foreground">{p.name}:</span>
          <span className="text-foreground">
            {prefix}{typeof p.value === 'number' ? fmtUsdShort(p.value).replace('$', '') : p.value}{suffix}
          </span>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------

export function ColorfulStats({ stats, analytics }: {
  stats: StatsSnapshot
  analytics: AnalyticsSnapshot | null
}) {
  const [tab, setTab] = useState<Tab>('overview')
  const totalHoursLifetime = stats.totalComputeMinutesLifetime / 60
  const maxRegionCount = Math.max(1, ...stats.regionDistribution.map(r => r.count))

  const showOverview    = tab === 'overview'
  const showProjections = tab === 'projections'
  const showCharts      = tab === 'charts'

  return (
    <>
      {/* Hero + tabs */}
      <section className="pt-24 sm:pt-32 lg:pt-40 pb-10 sm:pb-12 lg:pb-16 px-6 lg:px-12">
        <div className="max-w-[1200px] mx-auto">
          <div className="flex flex-wrap items-center gap-3 mb-6 sm:mb-8">
            <span className="w-8 h-px bg-foreground/30" />
            <span className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
              Network stats
            </span>
            <span className="hidden sm:block flex-1 h-px bg-foreground/10" />
            <span className="font-mono text-xs text-muted-foreground">
              Updated {new Date(stats.timestamp).toLocaleString()}
            </span>
          </div>
          <h1 className="font-display text-4xl sm:text-5xl md:text-7xl leading-[0.95] tracking-tight text-foreground mb-4 sm:mb-6 max-w-3xl">
            The numbers, in the open.
          </h1>
          <p className="text-base sm:text-lg text-muted-foreground max-w-2xl leading-relaxed">
            Real-time aggregation of TokenOS DeAI network metrics. Cards, charts, and projections drawn from the live database; refresh every 30 to 60 seconds.
          </p>

          {/* Tab toggle */}
          <div
            className="mt-8 inline-flex rounded-full p-1 border border-border"
            style={{ background: 'rgba(255, 255, 255, 0.04)' }}
          >
            {(['overview', 'projections', 'charts'] as Tab[]).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-1.5 rounded-full font-mono text-[11px] uppercase tracking-[0.18em] transition-colors ${
                  tab === t ? 'text-foreground' : 'text-muted-foreground hover:text-foreground/75'
                }`}
                style={tab === t ? {
                  background: 'rgba(34, 197, 94, 0.12)',
                  boxShadow: 'inset 0 0 0 1px rgba(34, 197, 94, 0.35)',
                } : undefined}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* OVERVIEW: top counters */}
      {showOverview && (
        <section className="px-6 lg:px-12 pb-16">
          <div className="max-w-[1200px] mx-auto grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-px bg-border">
            <BigStat label="GPUs online" value={stats.totalNodesOnline.toLocaleString()} unit={stats.totalNodesOnline === 1 ? 'machine' : 'machines'} />
            <BigStat label="Operators live" value={stats.totalOperatorsOnline.toLocaleString()} unit={stats.totalOperatorsOnline === 1 ? 'operator' : 'operators'} />
            <BigStat label="Lifetime rentals" value={stats.totalRentalsLifetime.toLocaleString()} unit="ACTIVE + COMPLETED" />
            <BigStat
              label="Lifetime GPU-hours"
              value={totalHoursLifetime >= 1000 ? `${(totalHoursLifetime / 1000).toFixed(1)}k` : totalHoursLifetime.toFixed(1)}
              unit="hours metered"
            />
          </div>
        </section>
      )}

      {/* CHARTS: daily revenue */}
      {showCharts && analytics && analytics.dailyRevenue.length > 0 && (
        <section className="px-6 lg:px-12 pb-16">
          <div className="max-w-[1200px] mx-auto">
            <SectionHeader eyebrow="Daily Network Revenue" caption="Last 30 days, sum across all operators" />
            <DailyRevenueChart data={analytics.dailyRevenue} />
          </div>
        </section>
      )}

      {/* PROJECTIONS: 3-Month Projections */}
      {showProjections && analytics && (
        <section className="px-6 lg:px-12 pb-16">
          <div className="max-w-[1200px] mx-auto">
            <SectionHeader
              eyebrow="3-Month Projections"
              caption={`Based on current run-rate. Growth applied month-over-month from last 30d trajectory (${analytics.projections.monthly.growthPct >= 0 ? '+' : ''}${analytics.projections.monthly.growthPct.toFixed(1)}%).`}
            />
            <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-border">
              <ProjectionCard label="Daily" data={analytics.projections.daily} tone={COLORS.green} />
              <ProjectionCard label="Weekly" data={analytics.projections.weekly} tone={COLORS.cyan} />
              <ProjectionCard label="Monthly" data={analytics.projections.monthly} tone={COLORS.purple} />
            </div>
          </div>
        </section>
      )}

      {/* PROJECTIONS: Monthly Projection Growth */}
      {showProjections && analytics && analytics.monthlyProjectionGrowth.length > 0 && (
        <section className="px-6 lg:px-12 pb-16">
          <div className="max-w-[1200px] mx-auto">
            <SectionHeader eyebrow="Monthly Projection Growth" caption="Three months forward, compounded from current trajectory" />
            <MonthlyProjectionChart data={analytics.monthlyProjectionGrowth} />
          </div>
        </section>
      )}

      {/* PROJECTIONS: Returns vs Cost */}
      {showProjections && analytics && (
        <section className="px-6 lg:px-12 pb-16">
          <div className="max-w-[1200px] mx-auto">
            <SectionHeader
              eyebrow="Returns vs Cost"
              caption="Network-wide aggregate. Sum of all operator capital deployed against lifetime earnings."
            />
            <ReturnsVsCostCard returnsVsCost={analytics.returnsVsCost} />
          </div>
        </section>
      )}

      {/* CHARTS: noderunner growth + power users */}
      {showCharts && analytics && (
        <section className="px-6 lg:px-12 pb-16">
          <div className="max-w-[1200px] mx-auto grid grid-cols-1 lg:grid-cols-2 gap-4">
            <NoderunnerGrowthChart data={analytics.noderunnerGrowth} />
            <PowerUserChart data={analytics.powerUsers} />
          </div>
        </section>
      )}

      {/* CHARTS: monthly financial performance */}
      {showCharts && analytics && (
        <section className="px-6 lg:px-12 pb-16">
          <div className="max-w-[1200px] mx-auto">
            <SectionHeader eyebrow="Monthly Financial Performance" caption="Revenue, operator payouts, buyer spend - last 6 months" />
            <MonthlyFinancialChart data={analytics.monthlyPerformance} />
          </div>
        </section>
      )}

      {/* CHARTS: rate history */}
      {showCharts && analytics && Object.keys(analytics.rateHistory).length > 0 && (
        <section className="px-6 lg:px-12 pb-16">
          <div className="max-w-[1200px] mx-auto">
            <SectionHeader eyebrow="Node Rate History" caption="Median rate per hour, last 60 days, by tier" />
            <RateHistoryChart history={analytics.rateHistory} />
          </div>
        </section>
      )}

      {/* CHARTS: rate table */}
      {showCharts && analytics && (
        <section className="px-6 lg:px-12 pb-16">
          <div className="max-w-[1200px] mx-auto">
            <SectionHeader eyebrow="Rate Table" caption="Current rates and 30-day band per tier" />
            <RateTableCard rates={analytics.rateTable} />
          </div>
        </section>
      )}

      {/* OVERVIEW: tier breakdown */}
      {showOverview && (
        <section className="px-6 lg:px-12 pb-16">
          <div className="max-w-[1200px] mx-auto">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-6">
              Online inventory by GPU tier
            </p>
            {stats.nodesByTier.length === 0 ? (
              <p className="text-muted-foreground text-sm">No nodes online right now.</p>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-5 gap-px bg-border">
                {stats.nodesByTier.map(t => {
                  const color = TIER_COLORS[t.gpuTier] ?? TIER_COLORS.OTHER
                  return (
                    <div key={t.gpuTier} className="bg-background p-6 relative overflow-hidden">
                      <p className="font-display text-4xl md:text-5xl text-foreground">{t.count}</p>
                      <p className="font-mono text-xs text-muted-foreground mt-2">{t.gpuTier}</p>
                      <span
                        aria-hidden
                        className="absolute inset-x-0 bottom-0 h-0.5"
                        style={{ background: color }}
                      />
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </section>
      )}

      {/* OVERVIEW: region distribution */}
      {showOverview && (
        <section className="px-6 lg:px-12 pb-16">
          <div className="max-w-[1200px] mx-auto">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-6">
              Online inventory by region
            </p>
            {stats.regionDistribution.length === 0 ? (
              <p className="text-muted-foreground text-sm">No regional data yet.</p>
            ) : (
              <ul className="space-y-3">
                {stats.regionDistribution.map(r => {
                  const pct = (r.count / maxRegionCount) * 100
                  return (
                    <li key={r.region} className="grid grid-cols-[120px_1fr_60px] md:grid-cols-[180px_1fr_80px] items-center gap-4">
                      <span className="font-mono text-sm text-foreground">{r.region}</span>
                      <span className="block h-2 bg-foreground/10 rounded-sm overflow-hidden">
                        <span
                          className="block h-full rounded-sm"
                          style={{
                            width: `${pct}%`,
                            background: `linear-gradient(90deg, ${COLORS.green}, ${COLORS.cyan})`,
                          }}
                        />
                      </span>
                      <span className="font-mono text-sm text-foreground text-right">{r.count}</span>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </section>
      )}

      {/* OVERVIEW: reference retail prices */}
      {showOverview && (
        <section className="px-6 lg:px-12 pb-16">
          <div className="max-w-[1200px] mx-auto">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-6">
              On-demand $/hr per tier
            </p>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-px bg-border">
              {stats.topPricesByTier.map(p => {
                const color = TIER_COLORS[p.gpuTier] ?? TIER_COLORS.OTHER
                return (
                  <div key={p.gpuTier} className="bg-background p-6 relative overflow-hidden">
                    <p className="font-mono text-xs mb-2" style={{ color }}>{p.gpuTier}</p>
                    <p className="font-display text-2xl md:text-3xl text-foreground">
                      ${p.ratePerHour.toFixed(2)}
                      <span className="font-mono text-xs text-muted-foreground"> / hr</span>
                    </p>
                    <p className="font-mono text-[11px] text-muted-foreground mt-1">
                      ${p.ratePerMinute.toFixed(4)} / min
                    </p>
                  </div>
                )
              })}
            </div>
          </div>
        </section>
      )}

      {/* OVERVIEW: carbon */}
      {showOverview && stats.totalCo2GramsLifetime > 0 && (
        <section className="px-6 lg:px-12 pb-16">
          <div className="max-w-[1200px] mx-auto py-8 border-t border-b border-border">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-2">
                  Lifetime carbon estimate
                </p>
                <p className="font-display text-3xl md:text-4xl text-foreground">
                  {stats.totalCo2GramsLifetime >= 1_000_000
                    ? `${(stats.totalCo2GramsLifetime / 1_000_000).toFixed(2)} t CO2`
                    : stats.totalCo2GramsLifetime >= 1000
                      ? `${(stats.totalCo2GramsLifetime / 1000).toFixed(1)} kg CO2`
                      : `${stats.totalCo2GramsLifetime.toFixed(0)} g CO2`}
                </p>
              </div>
              <p className="text-sm text-muted-foreground max-w-md">
                Estimate from GPU TDP times region grid intensity. Honest approximation, never a paid offset claim. Full formula on the buyer billing page.
              </p>
            </div>
          </div>
        </section>
      )}

      {/* Feeds shown on every tab */}
      <section className="px-6 lg:px-12 pb-24">
        <div className="max-w-[1200px] mx-auto py-8">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-4">
            Scrapeable feeds
          </p>
          <p className="text-muted-foreground mb-6 max-w-2xl">
            The full inventory catalog is available as JSON or CSV. Network analytics is available as JSON too. Use these instead of scraping the HTML.
          </p>
          <div className="flex flex-wrap gap-3 font-mono text-sm">
            <FeedLink href={`${API_URL}/v1/public/listings.json`} label="listings.json" />
            <FeedLink href={`${API_URL}/v1/public/listings.csv`} label="listings.csv" />
            <FeedLink href={`${API_URL}/v1/public/stats`} label="stats.json" />
            <FeedLink href={`${API_URL}/v1/public/network-analytics`} label="network-analytics.json" />
            <FeedLink href={`${API_URL}/docs`} label="OpenAPI spec" />
          </div>
        </div>
      </section>
    </>
  )
}

// ---------------------------------------------------------------------
// Chart cards (Recharts, colored)
// ---------------------------------------------------------------------

function DailyRevenueChart({ data }: { data: Array<{ date: string; revenue: number }> }) {
  const series = data.map(d => ({ date: fmtDay(d.date), value: d.revenue }))
  return (
    <div className="bg-card border border-border rounded-md p-6">
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={series} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
            <defs>
              <linearGradient id="grad-rev" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLORS.cyan} stopOpacity={0.65} />
                <stop offset="100%" stopColor={COLORS.cyan} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="date" tick={{ fill: 'var(--muted-foreground)', fontSize: 10 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
            <YAxis tick={{ fill: 'var(--muted-foreground)', fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v: number) => fmtUsdShort(v).replace('$', '')} />
            <Tooltip content={<ChartTooltip prefix="$" />} />
            <Area type="monotone" dataKey="value" name="Revenue" stroke={COLORS.cyan} strokeWidth={2} fill="url(#grad-rev)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function ProjectionCard({ label, data, tone }: {
  label: string
  data: { current: number; projected: number; growthPct: number }
  tone: string
}) {
  return (
    <div className="bg-background p-8 relative overflow-hidden">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] mb-3" style={{ color: tone }}>
        {label} run-rate
      </p>
      <p className="font-display text-4xl md:text-5xl text-foreground leading-none">
        {fmtUsdShort(data.current)}
      </p>
      <p className="font-mono text-xs text-muted-foreground mt-3">CURRENT</p>
      <div className="mt-5 pt-4 border-t border-border">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-1">
          Projected
        </p>
        <div className="flex items-end gap-3">
          <p className="font-display text-2xl text-foreground">{fmtUsdShort(data.projected)}</p>
          <p
            className="font-mono text-xs pb-1"
            style={{ color: data.growthPct >= 0 ? COLORS.green : COLORS.red }}
          >
            {data.growthPct >= 0 ? '+' : ''}{data.growthPct.toFixed(1)}%
          </p>
        </div>
      </div>
      <span
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-0.5"
        style={{ background: tone }}
      />
    </div>
  )
}

function MonthlyProjectionChart({ data }: { data: Array<{ month: string; projected: number }> }) {
  const series = data.map(d => ({ month: fmtMonth(d.month), value: d.projected }))
  return (
    <div className="bg-card border border-border rounded-md p-6">
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={series} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
            <defs>
              <linearGradient id="grad-proj" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLORS.purple} stopOpacity={0.95} />
                <stop offset="100%" stopColor={COLORS.pink} stopOpacity={0.7} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="month" tick={{ fill: 'var(--muted-foreground)', fontSize: 10 }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fill: 'var(--muted-foreground)', fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v: number) => fmtUsdShort(v).replace('$', '')} />
            <Tooltip content={<ChartTooltip prefix="$" />} />
            <Bar dataKey="value" name="Projected" fill="url(#grad-proj)" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function ReturnsVsCostCard({ returnsVsCost }: { returnsVsCost: AnalyticsSnapshot['returnsVsCost'] }) {
  const recoupPct = returnsVsCost.recoupRatio * 100
  return (
    <div className="bg-card border border-border rounded-md p-6 space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border">
        <BigStat label="Cost basis" value={fmtUsdShort(returnsVsCost.totalCostBasis)} unit="DEPLOYED" />
        <BigStat label="Lifetime earnings" value={fmtUsdShort(returnsVsCost.totalEarnings)} unit="RECEIVED" />
        <BigStat label="Recoup ratio" value={`${recoupPct.toFixed(1)}%`} unit="EARNINGS / COST" />
        <BigStat
          label="Break-even"
          value={returnsVsCost.breakEvenMonths === null
            ? '-'
            : returnsVsCost.recoupRatio >= 1
              ? 'reached'
              : `${returnsVsCost.breakEvenMonths.toFixed(1)}mo`}
          unit={returnsVsCost.breakEvenMonths === null ? 'NEED RUN-RATE' : 'AT CURRENT RATE'}
        />
      </div>
      <div>
        <div className="flex items-center justify-between font-mono text-[10px] text-muted-foreground uppercase tracking-[0.16em] mb-2">
          <span>Recoup progress</span>
          <span>{Math.min(100, recoupPct).toFixed(1)}% of cost basis</span>
        </div>
        <div className="h-3 rounded-full overflow-hidden" style={{ background: 'rgba(255, 255, 255, 0.06)' }}>
          <div
            className="h-full rounded-full"
            style={{
              width: `${Math.min(100, recoupPct)}%`,
              background: `linear-gradient(90deg, ${COLORS.green}, ${COLORS.cyan})`,
            }}
          />
        </div>
      </div>
    </div>
  )
}

function NoderunnerGrowthChart({ data }: { data: Array<{ date: string; total: number }> }) {
  const series = data.map(d => ({ date: fmtDay(d.date), value: d.total }))
  return (
    <div className="bg-card border border-border rounded-md p-6">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] mb-3" style={{ color: COLORS.purple }}>
        Noderunner Growth
      </p>
      <p className="text-sm text-muted-foreground mb-4">Cumulative count, last 90 days</p>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={series} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
            <defs>
              <linearGradient id="grad-nr" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLORS.purple} stopOpacity={0.6} />
                <stop offset="100%" stopColor={COLORS.purple} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="date" tick={{ fill: 'var(--muted-foreground)', fontSize: 10 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
            <YAxis tick={{ fill: 'var(--muted-foreground)', fontSize: 10 }} tickLine={false} axisLine={false} />
            <Tooltip content={<ChartTooltip />} />
            <Area type="monotone" dataKey="value" name="Noderunners" stroke={COLORS.purple} strokeWidth={2} fill="url(#grad-nr)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function PowerUserChart({ data }: { data: Array<{ date: string; count: number }> }) {
  const series = data.map(d => ({ date: fmtDay(d.date), value: d.count }))
  return (
    <div className="bg-card border border-border rounded-md p-6">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] mb-3" style={{ color: COLORS.pink }}>
        Power User Expansion
      </p>
      <p className="text-sm text-muted-foreground mb-4">Weekly buyers with $100+ spend, last 12 weeks</p>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={series} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
            <defs>
              <linearGradient id="grad-pu" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLORS.pink} stopOpacity={0.6} />
                <stop offset="100%" stopColor={COLORS.pink} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="date" tick={{ fill: 'var(--muted-foreground)', fontSize: 10 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
            <YAxis tick={{ fill: 'var(--muted-foreground)', fontSize: 10 }} tickLine={false} axisLine={false} />
            <Tooltip content={<ChartTooltip />} />
            <Area type="monotone" dataKey="value" name="Power users" stroke={COLORS.pink} strokeWidth={2} fill="url(#grad-pu)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function MonthlyFinancialChart({ data }: { data: AnalyticsSnapshot['monthlyPerformance'] }) {
  const series = data.map(d => ({
    month: fmtMonth(d.month),
    Revenue: d.revenue,
    Payouts: d.payouts,
  }))
  return (
    <div className="bg-card border border-border rounded-md p-6">
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={series} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="month" tick={{ fill: 'var(--muted-foreground)', fontSize: 10 }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fill: 'var(--muted-foreground)', fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v: number) => fmtUsdShort(v).replace('$', '')} />
            <Tooltip content={<ChartTooltip prefix="$" />} />
            <Legend wrapperStyle={{ fontFamily: 'var(--font-jetbrains, monospace)', fontSize: 10, color: 'var(--muted-foreground)' }} />
            <Bar dataKey="Revenue" fill={COLORS.green} radius={[2, 2, 0, 0]} />
            <Bar dataKey="Payouts" fill={COLORS.purple} radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function RateHistoryChart({ history }: { history: AnalyticsSnapshot['rateHistory'] }) {
  const dateSet = new Set<string>()
  Object.values(history).forEach(points => points.forEach(p => dateSet.add(p.date)))
  const dates = Array.from(dateSet).sort()
  const data = dates.map(date => {
    const row: Record<string, string | number> = { date: fmtDay(date) }
    for (const [tier, points] of Object.entries(history)) {
      const match = points.find(p => p.date === date)
      if (match) row[tier] = match.ratePerHour
    }
    return row
  })
  const tiers = Object.keys(history)
  return (
    <div className="bg-card border border-border rounded-md p-6">
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="date" tick={{ fill: 'var(--muted-foreground)', fontSize: 10 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
            <YAxis tick={{ fill: 'var(--muted-foreground)', fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v: number) => `$${v.toFixed(2)}`} />
            <Tooltip content={<ChartTooltip prefix="$" />} />
            <Legend wrapperStyle={{ fontFamily: 'var(--font-jetbrains, monospace)', fontSize: 10, color: 'var(--muted-foreground)' }} />
            {tiers.map(tier => (
              <Line
                key={tier}
                type="monotone"
                dataKey={tier}
                stroke={TIER_COLORS[tier] ?? TIER_COLORS.OTHER}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function RateTableCard({ rates }: { rates: AnalyticsSnapshot['rateTable'] }) {
  return (
    <div className="bg-card border border-border rounded-md overflow-x-auto">
      <table className="w-full font-mono text-sm">
        <thead className="bg-foreground/5">
          <tr className="text-left text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            <th className="px-4 py-3">Tier</th>
            <th className="px-4 py-3 text-right">Current $/hr</th>
            <th className="px-4 py-3 text-right">30d median</th>
            <th className="px-4 py-3 text-right">30d min</th>
            <th className="px-4 py-3 text-right">30d max</th>
            <th className="px-4 py-3 text-right">30d delta</th>
          </tr>
        </thead>
        <tbody>
          {rates.map(r => {
            const c = TIER_COLORS[r.gpuTier] ?? TIER_COLORS.OTHER
            return (
              <tr key={r.gpuTier} className="border-t border-border">
                <td className="px-4 py-3">
                  <span
                    className="font-mono text-[10px] px-2 py-0.5 rounded-sm"
                    style={{ background: `${c}22`, color: c, border: `1px solid ${c}55` }}
                  >
                    {r.gpuTier}
                  </span>
                </td>
                <td className="px-4 py-3 text-right text-foreground">${r.current.toFixed(2)}</td>
                <td className="px-4 py-3 text-right text-muted-foreground">${r.median30d.toFixed(2)}</td>
                <td className="px-4 py-3 text-right text-muted-foreground">${r.min30d.toFixed(2)}</td>
                <td className="px-4 py-3 text-right text-muted-foreground">${r.max30d.toFixed(2)}</td>
                <td
                  className="px-4 py-3 text-right"
                  style={{ color: r.deltaPct30d >= 0 ? COLORS.green : COLORS.red }}
                >
                  {r.deltaPct30d >= 0 ? '+' : ''}{r.deltaPct30d.toFixed(2)}%
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
