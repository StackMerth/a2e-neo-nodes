'use client'

/*
 * Colorful network statistics body for /stats. Client component so
 * Recharts can render. Page (server) fetches data + passes via props
 * so revalidate + metadata + initial SSR snapshot still works.
 *
 * Visual: dark slate background, neon-ish accent palette (green, cyan,
 * purple, pink, orange, blue) on cards and charts. Each chart owns its
 * own gradient + stroke so the page reads as a NEXUS-style network
 * dashboard rather than the cream editorial used by the rest of the
 * marketplace. Override is page-local; landing + leaderboard stay
 * editorial.
 */

import { useState } from 'react'
import Link from 'next/link'
import {
  BarChart, Bar, AreaChart, Area, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceLine,
} from 'recharts'
import {
  Cpu, Users, Zap, Clock, Wallet, TrendingUp, BarChart3, Activity,
  Building2, PieChart as PieIcon, LineChart as LineIcon, Globe, ShieldCheck,
  Flame, Coins,
} from 'lucide-react'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://tokenosdeai-api.onrender.com'

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
const fmtNumber = (n: number) => new Intl.NumberFormat('en-US').format(Math.round(n))
const fmtPct = (n: number, digits = 1) => `${n.toFixed(digits)}%`
const fmtMonth = (key: string) => {
  const [y, m] = key.split('-')
  if (!y || !m) return key
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}
const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

// ---------------------------------------------------------------------
// Palette
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
  slate:  '#64748b',
}
const TIER_COLORS: Record<string, string> = {
  H100:  COLORS.green,
  H200:  COLORS.blue,
  B200:  COLORS.purple,
  B300:  COLORS.amber,
  GB300: COLORS.red,
  OTHER: COLORS.slate,
}

// ---------------------------------------------------------------------
// Reusable atoms
// ---------------------------------------------------------------------

function MetricCard({ icon: Icon, label, value, sub, tone }: {
  icon: typeof Cpu
  label: string
  value: string
  sub?: string
  tone: string
}) {
  return (
    <div
      className="relative overflow-hidden rounded-xl p-5 transition-colors hover:bg-white/[0.04]"
      style={{
        background: 'rgba(15, 18, 30, 0.78)',
        border: '1px solid rgba(255, 255, 255, 0.06)',
        boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.04)',
      }}
    >
      <div className="flex items-start justify-between mb-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/50">
          {label}
        </p>
        <div
          className="w-7 h-7 rounded-md flex items-center justify-center shrink-0"
          style={{ background: `${tone}22`, border: `1px solid ${tone}55` }}
        >
          <Icon size={14} style={{ color: tone }} />
        </div>
      </div>
      <p className="font-display text-2xl md:text-[28px] leading-none text-white tracking-tight">
        {value}
      </p>
      {sub && (
        <p className="font-mono text-[11px] mt-2 text-white/55 truncate">{sub}</p>
      )}
      <span
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-px"
        style={{ background: `linear-gradient(90deg, transparent, ${tone}88, transparent)` }}
      />
    </div>
  )
}

function ChartCard({
  eyebrow, title, accent, children, action,
}: {
  eyebrow: string
  title: string
  accent: string
  children: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div
      className="rounded-xl p-5 sm:p-6 flex flex-col gap-4"
      style={{
        background: 'rgba(15, 18, 30, 0.78)',
        border: '1px solid rgba(255, 255, 255, 0.06)',
        boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.04)',
      }}
    >
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <p
            className="font-mono text-[10px] uppercase tracking-[0.2em] mb-1"
            style={{ color: accent }}
          >
            {eyebrow}
          </p>
          <h3 className="font-display text-xl md:text-2xl text-white tracking-tight">
            {title}
          </h3>
        </div>
        {action}
      </div>
      {children}
    </div>
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
    <div
      className="rounded-md px-3 py-2 font-mono text-[11px]"
      style={{
        background: 'rgba(10, 12, 20, 0.92)',
        border: '1px solid rgba(255, 255, 255, 0.12)',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.5)',
      }}
    >
      {label && (
        <p className="text-white/60 mb-1">{label}</p>
      )}
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-sm" style={{ background: p.color }} />
          <span className="text-white/70">{p.name}:</span>
          <span className="text-white">
            {prefix}{typeof p.value === 'number' ? fmtUsdShort(p.value).replace('$', prefix || '$') : p.value}{suffix}
          </span>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------

type Tab = 'overview' | 'projections' | 'charts'

export function ColorfulStats({ stats, analytics }: {
  stats: StatsSnapshot
  analytics: AnalyticsSnapshot | null
}) {
  const [tab, setTab] = useState<Tab>('overview')
  const totalHoursLifetime = stats.totalComputeMinutesLifetime / 60
  const projected90Day = analytics ? analytics.projections.monthly.projected * 3 : 0
  const recoupPct = analytics ? analytics.returnsVsCost.recoupRatio * 100 : 0
  const decentralization = stats.totalOperatorsOnline > 0
    ? stats.totalNodesOnline / stats.totalOperatorsOnline
    : 0

  return (
    <main
      className="relative min-h-screen"
      style={{
        background:
          'radial-gradient(ellipse at top, rgba(99, 102, 241, 0.10) 0%, transparent 50%), radial-gradient(ellipse at bottom right, rgba(236, 72, 153, 0.06) 0%, transparent 60%), #050714',
        color: '#ffffff',
      }}
    >
      <DotGrid />

      <section className="relative pt-32 sm:pt-40 pb-12 px-6 lg:px-12">
        <div className="max-w-[1280px] mx-auto">
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <span className="w-8 h-px bg-white/30" />
            <span className="font-mono text-xs uppercase tracking-[0.2em] text-white/55">
              Network Statistics
            </span>
            <span className="hidden sm:block flex-1 h-px bg-white/10" />
            <span className="font-mono text-xs text-white/40">
              Updated {new Date(stats.timestamp).toLocaleString()}
            </span>
          </div>
          <h1 className="font-display text-4xl sm:text-5xl md:text-6xl leading-[0.95] tracking-tight text-white mb-4">
            The network, in motion.
          </h1>
          <p className="text-base sm:text-lg text-white/55 max-w-2xl leading-relaxed">
            Real-time aggregation of TokenOS DeAI network metrics. Cards, charts, and projections drawn from the live database; refresh every 30 to 60 seconds.
          </p>

          {/* Tabs */}
          <div className="mt-8 inline-flex rounded-full p-1" style={{ background: 'rgba(255, 255, 255, 0.04)', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
            {(['overview', 'projections', 'charts'] as Tab[]).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-1.5 rounded-full font-mono text-[11px] uppercase tracking-[0.18em] transition-colors ${
                  tab === t ? 'text-white' : 'text-white/45 hover:text-white/75'
                }`}
                style={tab === t ? {
                  background: 'linear-gradient(135deg, rgba(34, 197, 94, 0.22), rgba(6, 182, 212, 0.18))',
                  boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0.10)',
                } : undefined}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Tab content */}
      {tab === 'overview' && (
        <OverviewTab
          stats={stats}
          analytics={analytics}
          totalHoursLifetime={totalHoursLifetime}
          projected90Day={projected90Day}
          recoupPct={recoupPct}
          decentralization={decentralization}
        />
      )}
      {tab === 'projections' && analytics && (
        <ProjectionsTab analytics={analytics} />
      )}
      {tab === 'charts' && analytics && (
        <ChartsTab stats={stats} analytics={analytics} />
      )}

      {/* Scrapeable feeds */}
      <section className="relative px-6 lg:px-12 py-16">
        <div className="max-w-[1280px] mx-auto">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/45 mb-4">
            Scrapeable feeds
          </p>
          <p className="text-white/55 mb-6 max-w-2xl text-sm">
            The full catalog and network analytics are available as JSON or CSV. Hit them directly instead of scraping the HTML.
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
    </main>
  )
}

// ---------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------

function OverviewTab({
  stats, analytics, totalHoursLifetime, projected90Day, recoupPct, decentralization,
}: {
  stats: StatsSnapshot
  analytics: AnalyticsSnapshot | null
  totalHoursLifetime: number
  projected90Day: number
  recoupPct: number
  decentralization: number
}) {
  return (
    <>
      {/* 12-card metric grid */}
      <section className="relative px-6 lg:px-12 pb-12">
        <div className="max-w-[1280px] mx-auto grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
          <MetricCard
            icon={Building2}
            label="Total Value Deployed"
            value={fmtUsdShort(analytics?.returnsVsCost.totalCostBasis ?? 0)}
            sub="Cumulative hardware capital"
            tone={COLORS.green}
          />
          <MetricCard
            icon={Wallet}
            label="Lifetime Earnings"
            value={fmtUsdShort(analytics?.returnsVsCost.totalEarnings ?? 0)}
            sub="Aggregate yield generated"
            tone={COLORS.cyan}
          />
          <MetricCard
            icon={TrendingUp}
            label="Projected 90d Revenue"
            value={fmtUsdShort(projected90Day)}
            sub="Run-rate + 30d growth"
            tone={COLORS.purple}
          />
          <MetricCard
            icon={ShieldCheck}
            label="Recoup Ratio"
            value={fmtPct(recoupPct)}
            sub="Earnings vs cost basis"
            tone={COLORS.green}
          />
          <MetricCard
            icon={Cpu}
            label="Active Nodes"
            value={fmtNumber(stats.totalNodesOnline)}
            sub={`${stats.totalNodesOnline === 1 ? 'machine' : 'machines'} online`}
            tone={COLORS.pink}
          />
          <MetricCard
            icon={Activity}
            label="Lifetime Rentals"
            value={fmtNumber(stats.totalRentalsLifetime)}
            sub="ACTIVE + COMPLETED"
            tone={COLORS.blue}
          />
          <MetricCard
            icon={Users}
            label="Active Operators"
            value={fmtNumber(stats.totalOperatorsOnline)}
            sub="Wallets with online nodes"
            tone={COLORS.amber}
          />
          <MetricCard
            icon={Clock}
            label="Lifetime GPU-Hours"
            value={totalHoursLifetime >= 1000 ? `${(totalHoursLifetime / 1000).toFixed(1)}k` : totalHoursLifetime.toFixed(1)}
            sub="Hours metered"
            tone={COLORS.orange}
          />
          <MetricCard
            icon={Zap}
            label="30d Growth"
            value={`${(analytics?.projections.monthly.growthPct ?? 0) >= 0 ? '+' : ''}${(analytics?.projections.monthly.growthPct ?? 0).toFixed(1)}%`}
            sub="vs prior 30d"
            tone={COLORS.pink}
          />
          <MetricCard
            icon={Coins}
            label="Monthly Run-Rate"
            value={fmtUsdShort(analytics?.projections.monthly.current ?? 0)}
            sub="Trailing 30d / 30"
            tone={COLORS.green}
          />
          <MetricCard
            icon={PieIcon}
            label="Avg Nodes / Wallet"
            value={decentralization.toFixed(1)}
            sub="Decentralization"
            tone={COLORS.purple}
          />
          <MetricCard
            icon={Flame}
            label="CO2 Lifetime"
            value={
              stats.totalCo2GramsLifetime >= 1_000_000
                ? `${(stats.totalCo2GramsLifetime / 1_000_000).toFixed(2)}t`
                : stats.totalCo2GramsLifetime >= 1000
                  ? `${(stats.totalCo2GramsLifetime / 1000).toFixed(1)}kg`
                  : `${stats.totalCo2GramsLifetime.toFixed(0)}g`
            }
            sub="Honest TDP estimate"
            tone={COLORS.red}
          />
        </div>
      </section>

      {/* Big daily revenue */}
      {analytics && analytics.dailyRevenue.length > 0 && (
        <section className="relative px-6 lg:px-12 pb-12">
          <div className="max-w-[1280px] mx-auto">
            <DailyRevenueChart data={analytics.dailyRevenue} />
          </div>
        </section>
      )}

      {/* Tier breakdown + region distribution */}
      <section className="relative px-6 lg:px-12 pb-12">
        <div className="max-w-[1280px] mx-auto grid grid-cols-1 lg:grid-cols-2 gap-4">
          <LiveTierBreakdownCard tiers={stats.nodesByTier} />
          <RegionalSpreadCard regions={stats.regionDistribution} />
        </div>
      </section>
    </>
  )
}

function ProjectionsTab({ analytics }: { analytics: AnalyticsSnapshot }) {
  return (
    <>
      <section className="relative px-6 lg:px-12 pb-12">
        <div className="max-w-[1280px] mx-auto grid grid-cols-1 md:grid-cols-3 gap-4">
          <ProjectionTile label="Daily run-rate" data={analytics.projections.daily} tone={COLORS.green} />
          <ProjectionTile label="Weekly run-rate" data={analytics.projections.weekly} tone={COLORS.cyan} />
          <ProjectionTile label="Monthly run-rate" data={analytics.projections.monthly} tone={COLORS.purple} />
        </div>
      </section>

      <section className="relative px-6 lg:px-12 pb-12">
        <div className="max-w-[1280px] mx-auto">
          <MonthlyProjectionChart data={analytics.monthlyProjectionGrowth} />
        </div>
      </section>

      <section className="relative px-6 lg:px-12 pb-12">
        <div className="max-w-[1280px] mx-auto">
          <ReturnsVsCostCard returnsVsCost={analytics.returnsVsCost} />
        </div>
      </section>
    </>
  )
}

function ChartsTab({ stats, analytics }: { stats: StatsSnapshot; analytics: AnalyticsSnapshot }) {
  return (
    <>
      <section className="relative px-6 lg:px-12 pb-8">
        <div className="max-w-[1280px] mx-auto grid grid-cols-1 lg:grid-cols-2 gap-4">
          <NoderunnerGrowthChart data={analytics.noderunnerGrowth} />
          <PowerUserChart data={analytics.powerUsers} />
        </div>
      </section>

      <section className="relative px-6 lg:px-12 pb-8">
        <div className="max-w-[1280px] mx-auto grid grid-cols-1 lg:grid-cols-2 gap-4">
          <LiveTierBreakdownCard tiers={stats.nodesByTier} />
          <MonthlyFinancialChart data={analytics.monthlyPerformance} />
        </div>
      </section>

      <section className="relative px-6 lg:px-12 pb-8">
        <div className="max-w-[1280px] mx-auto">
          <RateHistoryChart history={analytics.rateHistory} />
        </div>
      </section>

      <section className="relative px-6 lg:px-12 pb-8">
        <div className="max-w-[1280px] mx-auto">
          <RateTableCard rates={analytics.rateTable} />
        </div>
      </section>
    </>
  )
}

// ---------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------

function DailyRevenueChart({ data }: { data: Array<{ date: string; revenue: number }> }) {
  const series = data.map(d => ({ date: fmtDay(d.date), value: d.revenue }))
  const total = data.reduce((s, d) => s + d.revenue, 0)
  return (
    <ChartCard
      eyebrow="Yield - Daily"
      title="Daily Network Revenue"
      accent={COLORS.cyan}
      action={
        <div className="text-right">
          <p className="font-display text-2xl text-white">{fmtUsdShort(total)}</p>
          <p className="font-mono text-[11px] text-white/45">30d total</p>
        </div>
      }
    >
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={series} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
            <defs>
              <linearGradient id="grad-daily-rev" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLORS.cyan} stopOpacity={0.6} />
                <stop offset="100%" stopColor={COLORS.cyan} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="rgba(255, 255, 255, 0.04)" vertical={false} />
            <XAxis dataKey="date" tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10, fontFamily: 'var(--font-jetbrains, monospace)' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
            <YAxis tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10, fontFamily: 'var(--font-jetbrains, monospace)' }} tickLine={false} axisLine={false} tickFormatter={(v: number) => fmtUsdShort(v).replace('$', '')} />
            <Tooltip content={<ChartTooltip prefix="$" />} />
            <Area
              type="monotone"
              dataKey="value"
              name="Revenue"
              stroke={COLORS.cyan}
              strokeWidth={2}
              fill="url(#grad-daily-rev)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  )
}

function ProjectionTile({
  label, data, tone,
}: {
  label: string
  data: { current: number; projected: number; growthPct: number }
  tone: string
}) {
  return (
    <div
      className="rounded-xl p-6"
      style={{
        background: `linear-gradient(135deg, ${tone}14, rgba(15, 18, 30, 0.78))`,
        border: `1px solid ${tone}44`,
      }}
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] mb-3" style={{ color: tone }}>
        {label}
      </p>
      <p className="font-display text-4xl md:text-5xl text-white leading-none">
        {fmtUsdShort(data.current)}
      </p>
      <p className="font-mono text-[11px] text-white/45 mt-2">CURRENT</p>
      <div className="mt-5 pt-4 border-t border-white/10">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/55 mb-1">
          Projected
        </p>
        <div className="flex items-end gap-3">
          <p className="font-display text-2xl text-white">{fmtUsdShort(data.projected)}</p>
          <p
            className="font-mono text-xs pb-1"
            style={{ color: data.growthPct >= 0 ? COLORS.green : COLORS.red }}
          >
            {data.growthPct >= 0 ? '+' : ''}{data.growthPct.toFixed(1)}%
          </p>
        </div>
      </div>
    </div>
  )
}

function MonthlyProjectionChart({ data }: { data: Array<{ month: string; projected: number }> }) {
  const series = data.map(d => ({ month: fmtMonth(d.month), value: d.projected }))
  return (
    <ChartCard
      eyebrow="Forecast - 3 month"
      title="Monthly Projection Growth"
      accent={COLORS.purple}
    >
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={series} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
            <defs>
              <linearGradient id="grad-proj" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLORS.purple} stopOpacity={0.9} />
                <stop offset="100%" stopColor={COLORS.pink} stopOpacity={0.6} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="rgba(255, 255, 255, 0.04)" vertical={false} />
            <XAxis dataKey="month" tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10, fontFamily: 'var(--font-jetbrains, monospace)' }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10, fontFamily: 'var(--font-jetbrains, monospace)' }} tickLine={false} axisLine={false} tickFormatter={(v: number) => fmtUsdShort(v).replace('$', '')} />
            <Tooltip content={<ChartTooltip prefix="$" />} />
            <Bar dataKey="value" name="Projected" fill="url(#grad-proj)" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  )
}

function ReturnsVsCostCard({ returnsVsCost }: { returnsVsCost: AnalyticsSnapshot['returnsVsCost'] }) {
  const recoupPct = returnsVsCost.recoupRatio * 100
  return (
    <ChartCard
      eyebrow="Cumulative - Network"
      title="Returns vs Cost"
      accent={COLORS.green}
      action={
        <div className="text-right">
          <p className="font-display text-2xl text-white">{recoupPct.toFixed(1)}%</p>
          <p className="font-mono text-[11px] text-white/45">RECOUP</p>
        </div>
      }
    >
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatRow label="Cost basis" value={fmtUsdShort(returnsVsCost.totalCostBasis)} tone={COLORS.amber} />
        <StatRow label="Lifetime earnings" value={fmtUsdShort(returnsVsCost.totalEarnings)} tone={COLORS.green} />
        <StatRow label="Monthly avg" value={fmtUsdShort(returnsVsCost.monthlyAvgEarnings)} tone={COLORS.cyan} />
        <StatRow
          label="Break-even"
          value={
            returnsVsCost.breakEvenMonths === null
              ? '-'
              : returnsVsCost.recoupRatio >= 1
                ? 'reached'
                : `${returnsVsCost.breakEvenMonths.toFixed(1)}mo`
          }
          tone={COLORS.purple}
        />
      </div>
      {/* Progress bar */}
      <div>
        <div className="flex items-center justify-between font-mono text-[10px] text-white/45 uppercase tracking-[0.16em] mb-2">
          <span>Recoup progress</span>
          <span>{Math.min(100, recoupPct).toFixed(1)}% of cost basis</span>
        </div>
        <div className="h-3 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
          <div
            className="h-full rounded-full"
            style={{
              width: `${Math.min(100, recoupPct)}%`,
              background: `linear-gradient(90deg, ${COLORS.green}, ${COLORS.cyan})`,
            }}
          />
        </div>
      </div>
    </ChartCard>
  )
}

function NoderunnerGrowthChart({ data }: { data: Array<{ date: string; total: number }> }) {
  const series = data.map(d => ({ date: fmtDay(d.date), value: d.total }))
  const latest = data[data.length - 1]?.total ?? 0
  const earliest = data[0]?.total ?? 0
  const delta = latest - earliest
  return (
    <ChartCard
      eyebrow="Growth - Community"
      title="Noderunner Growth"
      accent={COLORS.purple}
      action={
        <div className="text-right">
          <p className="font-display text-2xl text-white">{fmtNumber(latest)}</p>
          <p className="font-mono text-[11px]" style={{ color: delta >= 0 ? COLORS.green : COLORS.red }}>
            {delta >= 0 ? '+' : ''}{delta} in 90d
          </p>
        </div>
      }
    >
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={series} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
            <defs>
              <linearGradient id="grad-nr" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLORS.purple} stopOpacity={0.55} />
                <stop offset="100%" stopColor={COLORS.purple} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="rgba(255, 255, 255, 0.04)" vertical={false} />
            <XAxis dataKey="date" tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10, fontFamily: 'var(--font-jetbrains, monospace)' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
            <YAxis tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10, fontFamily: 'var(--font-jetbrains, monospace)' }} tickLine={false} axisLine={false} />
            <Tooltip content={<ChartTooltip />} />
            <Area type="monotone" dataKey="value" name="Noderunners" stroke={COLORS.purple} strokeWidth={2} fill="url(#grad-nr)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  )
}

function PowerUserChart({ data }: { data: Array<{ date: string; count: number }> }) {
  const series = data.map(d => ({ date: fmtDay(d.date), value: d.count }))
  const total = data.reduce((s, d) => s + d.count, 0)
  return (
    <ChartCard
      eyebrow="Reach - Power users"
      title="Power User Expansion"
      accent={COLORS.pink}
      action={
        <div className="text-right">
          <p className="font-display text-2xl text-white">{fmtNumber(total)}</p>
          <p className="font-mono text-[11px] text-white/45">12w total</p>
        </div>
      }
    >
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={series} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
            <defs>
              <linearGradient id="grad-pu" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLORS.pink} stopOpacity={0.55} />
                <stop offset="100%" stopColor={COLORS.pink} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="rgba(255, 255, 255, 0.04)" vertical={false} />
            <XAxis dataKey="date" tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10, fontFamily: 'var(--font-jetbrains, monospace)' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
            <YAxis tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10, fontFamily: 'var(--font-jetbrains, monospace)' }} tickLine={false} axisLine={false} />
            <Tooltip content={<ChartTooltip />} />
            <Area type="monotone" dataKey="value" name="Power users" stroke={COLORS.pink} strokeWidth={2} fill="url(#grad-pu)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  )
}

function LiveTierBreakdownCard({ tiers }: { tiers: StatsSnapshot['nodesByTier'] }) {
  const data = tiers.map(t => ({
    name: t.gpuTier,
    value: t.count,
    color: TIER_COLORS[t.gpuTier] ?? TIER_COLORS.OTHER,
  }))
  const total = tiers.reduce((s, t) => s + t.count, 0)
  return (
    <ChartCard eyebrow="Live - Active nodes" title="Live Tier Breakdown" accent={COLORS.green}>
      {data.length === 0 ? (
        <p className="text-sm text-white/55">No nodes online right now.</p>
      ) : (
        <div className="flex flex-col sm:flex-row items-center gap-6">
          <div className="h-48 w-48 relative shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={data} innerRadius={52} outerRadius={88} paddingAngle={3} dataKey="value">
                  {data.map(d => <Cell key={d.name} fill={d.color} stroke="transparent" />)}
                </Pie>
                <Tooltip content={<ChartTooltip suffix="" />} />
              </PieChart>
            </ResponsiveContainer>
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <span className="font-display text-3xl text-white">{total}</span>
              <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-white/45">
                Total
              </span>
            </div>
          </div>
          <div className="flex-1 w-full space-y-2">
            {data.map(d => {
              const pct = total > 0 ? (d.value / total) * 100 : 0
              return (
                <div key={d.name} className="flex items-center gap-3">
                  <span
                    className="font-mono text-[10px] px-2 py-0.5 rounded-sm"
                    style={{ background: `${d.color}22`, color: d.color, border: `1px solid ${d.color}55` }}
                  >
                    {d.name}
                  </span>
                  <span className="flex-1 font-mono text-[11px] text-white/45">{pct.toFixed(1)}%</span>
                  <span className="font-mono text-sm text-white">{d.value}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </ChartCard>
  )
}

function RegionalSpreadCard({ regions }: { regions: StatsSnapshot['regionDistribution'] }) {
  const max = Math.max(1, ...regions.map(r => r.count))
  return (
    <ChartCard eyebrow="Reach - Regions" title="Regional Spread" accent={COLORS.cyan}>
      {regions.length === 0 ? (
        <p className="text-sm text-white/55">No regional data yet.</p>
      ) : (
        <ul className="space-y-3">
          {regions.map(r => {
            const pct = (r.count / max) * 100
            return (
              <li key={r.region} className="grid grid-cols-[100px_1fr_60px] md:grid-cols-[140px_1fr_80px] items-center gap-4">
                <span className="font-mono text-sm text-white">{r.region}</span>
                <span className="block h-2 rounded-sm overflow-hidden" style={{ background: 'rgba(255, 255, 255, 0.06)' }}>
                  <span
                    className="block h-full rounded-sm"
                    style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${COLORS.cyan}, ${COLORS.purple})` }}
                  />
                </span>
                <span className="font-mono text-sm text-white text-right">{r.count}</span>
              </li>
            )
          })}
        </ul>
      )}
    </ChartCard>
  )
}

function MonthlyFinancialChart({ data }: { data: AnalyticsSnapshot['monthlyPerformance'] }) {
  const series = data.map(d => ({
    month: fmtMonth(d.month),
    Revenue: d.revenue,
    Payouts: d.payouts,
  }))
  return (
    <ChartCard eyebrow="Financial - Monthly" title="Monthly Financial Performance" accent={COLORS.green}>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={series} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
            <CartesianGrid stroke="rgba(255, 255, 255, 0.04)" vertical={false} />
            <XAxis dataKey="month" tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10, fontFamily: 'var(--font-jetbrains, monospace)' }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10, fontFamily: 'var(--font-jetbrains, monospace)' }} tickLine={false} axisLine={false} tickFormatter={(v: number) => fmtUsdShort(v).replace('$', '')} />
            <Tooltip content={<ChartTooltip prefix="$" />} />
            <Legend wrapperStyle={{ fontFamily: 'var(--font-jetbrains, monospace)', fontSize: 10, color: 'rgba(255,255,255,0.5)' }} />
            <Bar dataKey="Revenue" fill={COLORS.green} radius={[2, 2, 0, 0]} />
            <Bar dataKey="Payouts" fill={COLORS.purple} radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  )
}

function RateHistoryChart({ history }: { history: AnalyticsSnapshot['rateHistory'] }) {
  // Build a unified date axis: union of all tier-date pairs
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
    <ChartCard
      eyebrow="Yield - Rate trajectory"
      title="Node Rate History (60d)"
      accent={COLORS.amber}
    >
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
            <CartesianGrid stroke="rgba(255, 255, 255, 0.04)" vertical={false} />
            <XAxis dataKey="date" tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10, fontFamily: 'var(--font-jetbrains, monospace)' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
            <YAxis tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10, fontFamily: 'var(--font-jetbrains, monospace)' }} tickLine={false} axisLine={false} tickFormatter={(v: number) => `$${v.toFixed(2)}`} />
            <Tooltip content={<ChartTooltip prefix="$" />} />
            <Legend wrapperStyle={{ fontFamily: 'var(--font-jetbrains, monospace)', fontSize: 10, color: 'rgba(255,255,255,0.5)' }} />
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
    </ChartCard>
  )
}

function RateTableCard({ rates }: { rates: AnalyticsSnapshot['rateTable'] }) {
  return (
    <ChartCard eyebrow="Rate transparency" title="Rate Table" accent={COLORS.orange}>
      <div className="overflow-x-auto">
        <table className="w-full font-mono text-sm">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-[0.18em] text-white/45">
              <th className="px-3 py-2">Tier</th>
              <th className="px-3 py-2 text-right">Current $/hr</th>
              <th className="px-3 py-2 text-right">30d median</th>
              <th className="px-3 py-2 text-right">30d min</th>
              <th className="px-3 py-2 text-right">30d max</th>
              <th className="px-3 py-2 text-right">30d delta</th>
            </tr>
          </thead>
          <tbody>
            {rates.map(r => {
              const c = TIER_COLORS[r.gpuTier] ?? TIER_COLORS.OTHER
              return (
                <tr key={r.gpuTier} className="border-t border-white/5">
                  <td className="px-3 py-3">
                    <span
                      className="font-mono text-[10px] px-2 py-0.5 rounded-sm"
                      style={{ background: `${c}22`, color: c, border: `1px solid ${c}55` }}
                    >
                      {r.gpuTier}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right text-white">${r.current.toFixed(2)}</td>
                  <td className="px-3 py-3 text-right text-white/65">${r.median30d.toFixed(2)}</td>
                  <td className="px-3 py-3 text-right text-white/65">${r.min30d.toFixed(2)}</td>
                  <td className="px-3 py-3 text-right text-white/65">${r.max30d.toFixed(2)}</td>
                  <td
                    className="px-3 py-3 text-right"
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
    </ChartCard>
  )
}

// ---------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------

function StatRow({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div
      className="rounded-md p-3"
      style={{ background: 'rgba(255,255,255,0.03)', border: `1px solid ${tone}33` }}
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/55 mb-1">{label}</p>
      <p className="font-display text-lg text-white">{value}</p>
    </div>
  )
}

function FeedLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-2 px-3 py-2 rounded-md transition-colors"
      style={{
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.10)',
        color: 'rgba(255, 255, 255, 0.85)',
      }}
    >
      {label}
      <span aria-hidden>↗</span>
    </Link>
  )
}

function DotGrid() {
  return (
    <div
      aria-hidden
      className="absolute inset-0 pointer-events-none"
      style={{
        backgroundImage: 'radial-gradient(circle, rgba(255, 255, 255, 0.06) 1px, transparent 1px)',
        backgroundSize: '32px 32px',
        opacity: 0.5,
        maskImage: 'linear-gradient(180deg, black, transparent 90%)',
        WebkitMaskImage: 'linear-gradient(180deg, black, transparent 90%)',
      }}
    />
  )
}
