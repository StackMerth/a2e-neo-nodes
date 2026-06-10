'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer,
  PieChart, Pie, Cell, Area, AreaChart,
} from 'recharts'
import {
  DollarSign,
  Server,
  Activity,
  Wallet,
  Plus,
  ArrowDownToLine,
  Globe,
  Cpu,
  Zap,
  CalendarDays,
  Trophy,
  Flame,
  PiggyBank,
  Building2,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  TrendingUp,
  TrendingDown,
  Minus,
  Sparkles,
  Info,
} from 'lucide-react'
import Link from 'next/link'
import { nodeRunner } from '@/lib/api'
import { A2ELoader } from '@/components/ui/A2ELoader'
import { useWebSocket } from '@/hooks/useWebSocket'
import {
  DashboardShell,
  DashboardMainColumn,
  DashboardRightRail,
  SectionCard,
  MetricTriad,
  ClockCard,
  QuickActions,
  ResourceAllocation,
} from '@/components/dashboard/FuturisticShell'

interface DashboardData {
  earnings: { today: number; week: number; month: number; allTime: number }
  nodes: { total: number; online: number; offline: number; maintenance: number; paused?: number; inUse?: number; externallyListed?: number }
  jobs: { completed: number; running: number }
  totalPaidOut: number
  uptimePercent: number
  dailyEarnings?: { date: string; amount: number }[]
}

interface PayoutCalendarEntry { date: string; amount: number }
interface PerNodeEarnings { nodeId: string; label: string; gpuTier: string; earnings: number }
interface RecentPayout {
  id: string
  amount: number
  status: string
  txHash: string | null
  createdAt: string
  nodeId: string
}

interface NodesByTier { gpuTier: string; count: number }
interface UpcomingPayout {
  completesAt: string
  expectedAmount: number
  gpuTier: string
  nodeId: string
  requestId: string
}

interface OperatorStatsData {
  pendingPayout: number
  capitalDeployed: number
  leaderboardRank: number
  totalRanked: number
  reputationScore: number
  reputationTier: 'BRONZE' | 'SILVER' | 'GOLD' | 'PLATINUM'
  uptimeStreak: number
  payoutCalendar: PayoutCalendarEntry[]
  perNodeEarnings: PerNodeEarnings[]
  recentPayouts: RecentPayout[]
  nodesByTier: NodesByTier[]
  upcomingPayouts: UpcomingPayout[]
}

const NODE_STATUS_COLORS: Record<string, string> = {
  Online:      '#22c55e',
  Offline:     '#ef4444',
  Maintenance: '#f59e0b',
  Paused:      '#3b82f6',
  'In Use':    '#8b5cf6',
}

// Same palette as the Nodes page tier chips. Used to color the GPU
// tier breakdown on the right of the Node Status Mix donut so the
// card has content even when all nodes are in the same status.
const TIER_COLORS: Record<string, string> = {
  H100:  '#22c55e',
  H200:  '#3b82f6',
  B200:  '#8b5cf6',
  B300:  '#f59e0b',
  GB300: '#ef4444',
  OTHER: '#94a3b8',
}

const TIER_TONE: Record<OperatorStatsData['reputationTier'], string> = {
  BRONZE:   '#a16207',
  SILVER:   '#94a3b8',
  GOLD:     '#eab308',
  PLATINUM: '#22d3ee',
}

const formatCurrency = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)

const formatCurrencyShort = (n: number) => {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `$${(n / 1_000).toFixed(1)}k`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}k`
  return formatCurrency(n)
}

const formatDateShort = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

interface TooltipPayloadItem { name: string; value: number; color?: string }
function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: TooltipPayloadItem[]; label?: string }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-md border border-border px-3 py-2" style={{ background: 'var(--bg-card)' }}>
      <p className="font-mono text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>{label ?? payload[0].name}</p>
      <p className="font-mono text-sm" style={{ color: 'var(--text-primary)' }}>
        {typeof payload[0].value === 'number'
          ? formatCurrency(payload[0].value)
          : payload[0].value}
      </p>
    </div>
  )
}

/**
 * Richer tooltip for the daily earnings bar chart. Adds the
 * "Mon · May 19" date treatment and treats zero-amount bars as
 * "No earnings" so an empty day reads as a quiet info state instead
 * of looking like missing data.
 */
function EarningsBarTooltip({ active, payload, label }: { active?: boolean; payload?: TooltipPayloadItem[]; label?: string }) {
  if (!active || !payload?.length) return null
  const value = typeof payload[0].value === 'number' ? payload[0].value : 0
  return (
    <div className="rounded-md border px-3 py-2 shadow-lg" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-color)' }}>
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] mb-1" style={{ color: 'var(--text-muted)' }}>
        {label ?? payload[0].name}
      </p>
      <p
        className="font-mono text-sm"
        style={{ color: value > 0 ? 'var(--primary)' : 'var(--text-muted)' }}
      >
        {value > 0 ? formatCurrency(value) : 'No earnings'}
      </p>
    </div>
  )
}

/**
 * Small KPI stat used in the chart card's summary strip. Two lines:
 * mono label up top, big value below, optional sub-line. Stays inside
 * the SectionCard padding so it reads as part of the chart, not as a
 * separate card.
 */
function ChartSummaryStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-[0.16em]" style={{ color: 'var(--text-muted)' }}>
        {label}
      </p>
      <p className="font-mono text-lg font-semibold mt-1" style={{ color: 'var(--text-primary)' }}>
        {value}
      </p>
      {sub && (
        <p className="font-mono text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
          {sub}
        </p>
      )}
    </div>
  )
}

/**
 * Trend chip rendered next to the forecast headline. Reads ±N% with an
 * arrow direction; subtle tone so the chip doesn't overpower the
 * number itself. Returns nothing inside the JSX when delta is within
 * the noise band (<= 1%) to avoid surfacing fake precision.
 */
function ForecastTrendChip({ deltaPct }: { deltaPct: number }) {
  const isFlat = Math.abs(deltaPct) < 1
  const isUp = deltaPct >= 1
  const Icon = isFlat ? Minus : isUp ? TrendingUp : TrendingDown
  const color = isFlat ? 'var(--text-muted)' : isUp ? 'var(--primary)' : '#ef4444'
  const bg = isFlat
    ? 'rgba(255,255,255,0.04)'
    : isUp
      ? 'rgba(34,197,94,0.12)'
      : 'rgba(239,68,68,0.12)'
  const sign = isFlat ? '' : isUp ? '+' : ''
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-mono"
      style={{ background: bg, color }}
      title="Vs the prior 7 days average"
    >
      <Icon size={12} />
      {sign}{deltaPct.toFixed(1)}% vs last week
    </span>
  )
}

/**
 * Horizontal range bar visualization for the ±15% forecast band.
 * Renders the low / projected / high markers along a single line so
 * the conservative band reads as a magnitude, not a comma-separated
 * pair of numbers. The projected value sits at 50% by design (range
 * is symmetric ±15% around it).
 */
function ForecastRangeBar({ low, projected, high }: { low: number; projected: number; high: number }) {
  return (
    <div className="space-y-1.5">
      <div className="relative h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
        {/* Filled band running from low to high marker positions */}
        <span
          aria-hidden
          className="absolute inset-y-0 rounded-full"
          style={{
            left: '0%',
            right: '0%',
            background: 'linear-gradient(90deg, rgba(34,197,94,0.25), rgba(34,197,94,0.45), rgba(34,197,94,0.25))',
          }}
        />
        {/* Projected marker (50% by definition since range is symmetric) */}
        <span
          aria-hidden
          className="absolute top-1/2 -translate-y-1/2 w-1 h-3 rounded-full"
          style={{ left: '50%', transform: 'translate(-50%, -50%)', background: 'var(--primary)', boxShadow: '0 0 6px rgba(34,197,94,0.6)' }}
        />
      </div>
      <div className="flex items-center justify-between text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
        <span>${low.toFixed(2)}</span>
        <span style={{ color: 'var(--text-secondary)' }}>${projected.toFixed(2)} projected</span>
        <span>${high.toFixed(2)}</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// Sub-components for the new operator analytics row.
// Pulled inline (not in FuturisticShell) because they consume the
// operator-stats response directly and are dashboard-specific.
// ---------------------------------------------------------------------

function OperatorStatTile({
  label, value, sub, icon: Icon, tone, href,
}: {
  label: string
  value: string
  sub?: string
  icon: typeof DollarSign
  tone: string
  /** Optional internal path. Renders the tile as a Link with hover lift when set. */
  href?: string
}) {
  const Body = (
    <>
      <div
        className="w-9 h-9 shrink-0 rounded-md flex items-center justify-center"
        style={{ background: `${tone}1a`, border: `1px solid ${tone}55` }}
      >
        <Icon className="w-4 h-4" style={{ color: tone }} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-mono text-[10px] tracking-[0.14em] uppercase truncate" style={{ color: 'var(--text-muted)' }}>
          {label}
        </p>
        <p className="font-display text-xl mt-0.5 truncate" style={{ color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
          {value}
        </p>
        {sub && (
          <p className="font-mono text-[10px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>
            {sub}
          </p>
        )}
      </div>
    </>
  )

  const baseClass = 'rounded-md p-3 flex items-start gap-3'
  const baseStyle = {
    background: 'var(--glass-bg)',
    border: '1px solid var(--glass-border)',
    backdropFilter: 'blur(var(--glass-blur, 16px))',
  } as const

  if (href) {
    return (
      <Link
        href={href}
        className={`${baseClass} transition-all hover:-translate-y-0.5 hover:border-foreground/30`}
        style={baseStyle}
      >
        {Body}
      </Link>
    )
  }
  return (
    <div className={baseClass} style={baseStyle}>
      {Body}
    </div>
  )
}


// ---------------------------------------------------------------------
// Forward-looking payout schedule. Replaces the trailing 30-day heatmap
// with a real monthly calendar + countdown panel + upcoming list.
// ---------------------------------------------------------------------

/**
 * Operator-facing info banner explaining the current payout policy.
 *
 * Visual borrowed from the TokenOS_COMPUTE marketing dashboard (blue
 * tinted card, left accent border, info icon, mono small-caps label,
 * key timing call-out in bold). Copy is rewritten to reflect the
 * post-Patch-#7 admin-approved withdrawal flow rather than the
 * auto-payout wording from the screenshot, which is no longer
 * accurate as of 2026-06-10.
 *
 * Stateless and self-contained — drop wherever it makes sense at
 * the top of the dashboard view.
 */
function AutomaticSettlementBanner() {
  return (
    <div
      className="rounded-xl p-4 flex items-start gap-3 mb-6"
      style={{
        background: 'rgba(59, 130, 246, 0.06)',
        border: '1px solid rgba(59, 130, 246, 0.20)',
        borderLeft: '3px solid rgba(59, 130, 246, 0.55)',
      }}
    >
      <div
        className="flex-shrink-0 mt-0.5 w-7 h-7 rounded-md flex items-center justify-center"
        style={{ background: 'rgba(59, 130, 246, 0.15)' }}
      >
        <Info size={14} style={{ color: '#60a5fa' }} />
      </div>
      <div className="min-w-0">
        <p
          className="font-mono text-[10px] uppercase tracking-[0.18em] mb-1.5"
          style={{ color: '#60a5fa' }}
        >
          Automatic Settlement
        </p>
        <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          Earnings accumulate continuously from your node uptime. Request a payout
          anytime from the{' '}
          <Link
            href="/payouts"
            className="underline decoration-dotted underline-offset-2 hover:no-underline"
            style={{ color: 'var(--text-primary)' }}
          >
            Payouts page
          </Link>
          {' '}— funds typically arrive within{' '}
          <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>
            1–2 business days
          </span>{' '}
          of admin approval.
        </p>
      </div>
    </div>
  )
}

function PayoutScheduleCard({ payouts }: { payouts: UpcomingPayout[] }) {
  const today = useMemo(() => {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), d.getDate())
  }, [])
  const [viewMonth, setViewMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1))
  const [now, setNow] = useState(() => new Date())

  // Tick once a second so the countdown updates.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  // Group payouts by date (YYYY-MM-DD) for calendar dots, and into
  // tier-clustered rows (same completesAt + tier) for the upcoming list.
  const byDate = useMemo(() => {
    const m = new Map<string, UpcomingPayout[]>()
    for (const p of payouts) {
      const key = p.completesAt.slice(0, 10)
      const arr = m.get(key) ?? []
      arr.push(p)
      m.set(key, arr)
    }
    return m
  }, [payouts])

  const clusters = useMemo(() => {
    const m = new Map<string, { completesAt: string; gpuTier: string; count: number; totalAmount: number }>()
    for (const p of payouts) {
      const key = `${p.completesAt}::${p.gpuTier}`
      const c = m.get(key) ?? {
        completesAt: p.completesAt, gpuTier: p.gpuTier, count: 0, totalAmount: 0,
      }
      c.count += 1
      c.totalAmount += p.expectedAmount
      m.set(key, c)
    }
    return Array.from(m.values()).sort((a, b) => a.completesAt.localeCompare(b.completesAt))
  }, [payouts])

  const expectedTotal = useMemo(
    () => payouts.reduce((s, p) => s + p.expectedAmount, 0),
    [payouts],
  )
  const firstCluster = clusters[0]

  // Calendar grid: 6 rows x 7 cols, padded with prior/next month bleed.
  const cells = useMemo(() => {
    const firstOfMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1)
    const startWeekday = firstOfMonth.getDay()
    const daysInMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0).getDate()
    const cells: Array<{ date: Date | null; inMonth: boolean }> = []
    for (let i = 0; i < startWeekday; i++) cells.push({ date: null, inMonth: false })
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({ date: new Date(viewMonth.getFullYear(), viewMonth.getMonth(), d), inMonth: true })
    }
    while (cells.length < 42) cells.push({ date: null, inMonth: false })
    return cells
  }, [viewMonth])

  const monthLabel = viewMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

  function fmtCountdown(target: Date): string {
    const diff = target.getTime() - now.getTime()
    if (diff <= 0) return 'now'
    const totalSec = Math.floor(diff / 1000)
    const d = Math.floor(totalSec / 86400)
    const h = Math.floor((totalSec % 86400) / 3600)
    const m = Math.floor((totalSec % 3600) / 60)
    const s = totalSec % 60
    return `${d}d ${h}h ${m}m ${s}s`
  }

  return (
    <SectionCard
      title="Payout Calendar"
      badge={
        <span className="font-mono text-[10px] tracking-[0.18em] uppercase ml-1" style={{ color: '#a78bfa' }}>
          Schedule
        </span>
      }
      icon={CalendarDays}
    >
      <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-6">
        {/* Calendar */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <button
              onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1))}
              className="w-9 h-9 rounded-md inline-flex items-center justify-center transition-colors"
              style={{ background: 'var(--surface-elevated)', border: '1px solid var(--border-color)' }}
              aria-label="Previous month"
            >
              <ChevronLeft size={16} style={{ color: 'var(--text-secondary)' }} />
            </button>
            <p className="font-display text-base sm:text-lg tracking-tight" style={{ color: 'var(--text-primary)' }}>
              {monthLabel}
            </p>
            <button
              onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1))}
              className="w-9 h-9 rounded-md inline-flex items-center justify-center transition-colors"
              style={{ background: 'var(--surface-elevated)', border: '1px solid var(--border-color)' }}
              aria-label="Next month"
            >
              <ChevronRight size={16} style={{ color: 'var(--text-secondary)' }} />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-1 mb-1">
            {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(d => (
              <div key={d} className="font-mono text-[10px] uppercase text-center py-1" style={{ color: 'var(--text-muted)' }}>
                {d}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-1">
            {cells.map((cell, idx) => {
              if (!cell.date) {
                return <div key={idx} className="aspect-square" />
              }
              const key = `${cell.date.getFullYear()}-${String(cell.date.getMonth() + 1).padStart(2, '0')}-${String(cell.date.getDate()).padStart(2, '0')}`
              const dayPayouts = byDate.get(key) ?? []
              const isToday = cell.date.getTime() === today.getTime()
              const tiers = Array.from(new Set(dayPayouts.map(p => p.gpuTier)))
              return (
                <div
                  key={idx}
                  className="aspect-square rounded-md relative flex flex-col items-center justify-center transition-colors"
                  style={{
                    background: isToday ? 'rgba(139, 92, 246, 0.10)' : 'transparent',
                    border: isToday ? '1px solid rgba(139, 92, 246, 0.45)' : '1px solid transparent',
                  }}
                  title={dayPayouts.length > 0 ? `${dayPayouts.length} payout${dayPayouts.length === 1 ? '' : 's'}` : undefined}
                >
                  <span
                    className="font-mono text-sm"
                    style={{
                      color: isToday
                        ? 'var(--text-primary)'
                        : dayPayouts.length > 0
                          ? 'var(--text-primary)'
                          : 'var(--text-muted)',
                      fontWeight: isToday || dayPayouts.length > 0 ? 600 : 400,
                    }}
                  >
                    {cell.date.getDate()}
                  </span>
                  {tiers.length > 0 && (
                    <div className="absolute bottom-1 flex items-center gap-0.5">
                      {tiers.slice(0, 4).map(t => (
                        <span
                          key={t}
                          className="w-1.5 h-1.5 rounded-full"
                          style={{ background: TIER_COLORS[t] ?? TIER_COLORS.OTHER }}
                        />
                      ))}
                      {tiers.length > 4 && (
                        <span className="font-mono text-[8px]" style={{ color: 'var(--text-muted)' }}>+</span>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Tier legend */}
          <div className="mt-5 pt-4 border-t border-border-subtle flex flex-wrap gap-4">
            {(['H100', 'H200', 'B200', 'B300', 'GB300'] as const).map(t => (
              <span key={t} className="inline-flex items-center gap-1.5 font-mono text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                <span className="w-2 h-2 rounded-full" style={{ background: TIER_COLORS[t] }} />
                {t}
              </span>
            ))}
          </div>
        </div>

        {/* Right panel */}
        <div className="flex flex-col gap-4">
          {/* Next node completes in */}
          <div
            className="rounded-lg p-4"
            style={{
              background: 'rgba(139, 92, 246, 0.08)',
              border: '1px solid rgba(139, 92, 246, 0.35)',
            }}
          >
            <p className="font-mono text-[10px] uppercase tracking-[0.18em]" style={{ color: '#a78bfa' }}>
              Next node completes in
            </p>
            {firstCluster ? (
              <>
                <p className="font-display text-2xl sm:text-[28px] leading-tight tracking-tight mt-2" style={{ color: '#a78bfa' }}>
                  {fmtCountdown(new Date(firstCluster.completesAt))}
                </p>
                <p className="font-mono text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                  {firstCluster.count}x {firstCluster.gpuTier}
                </p>
              </>
            ) : (
              <p className="font-mono text-sm mt-2" style={{ color: 'var(--text-muted)' }}>
                No active rentals
              </p>
            )}
          </div>

          {/* Upcoming list */}
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] mb-3" style={{ color: 'var(--text-muted)' }}>
              Upcoming
            </p>
            {clusters.length === 0 ? (
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                Scheduled payouts will appear here as your nodes start serving rentals.
              </p>
            ) : (
              <div className="space-y-2">
                {clusters.slice(0, 3).map((c, i) => (
                  <div
                    key={i}
                    className="rounded-lg p-3 flex items-start justify-between gap-3"
                    style={{
                      background: 'var(--surface-elevated)',
                      borderLeft: `3px solid ${TIER_COLORS[c.gpuTier] ?? TIER_COLORS.OTHER}`,
                      border: '1px solid var(--border-color)',
                      borderLeftWidth: 3,
                    }}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-display text-sm" style={{ color: 'var(--text-primary)' }}>
                        {new Date(c.completesAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </p>
                      <p className="font-mono text-[11px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                        {c.count}x {c.gpuTier}
                      </p>
                      <p className="font-mono text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                        {fmtCountdown(new Date(c.completesAt))}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-display text-base" style={{ color: '#22c55e' }}>
                        ~{formatCurrencyShort(c.totalAmount)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Expected total */}
          <div className="pt-3 border-t border-border-subtle">
            <div className="flex items-baseline justify-between">
              <p className="font-mono text-[10px] uppercase tracking-[0.18em]" style={{ color: 'var(--text-muted)' }}>
                Expected total
              </p>
              <p className="font-display text-xl" style={{ color: '#a78bfa' }}>
                ~{formatCurrencyShort(expectedTotal)}
              </p>
            </div>
            <p className="text-xs mt-2 italic" style={{ color: 'var(--text-muted)' }}>
              Payouts are sent within 24 hours of node completion.
            </p>
          </div>
        </div>
      </div>
    </SectionCard>
  )
}

function TierBreakdown({ tiers, total }: { tiers: NodesByTier[]; total: number }) {
  if (tiers.length === 0 || total === 0) {
    return <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No tier data yet.</p>
  }
  return (
    <div className="space-y-3">
      {/* Stacked horizontal bar showing tier proportions */}
      <div className="h-3 w-full rounded-sm overflow-hidden flex" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--glass-border)' }}>
        {tiers.map(t => {
          const pct = (t.count / total) * 100
          const color = TIER_COLORS[t.gpuTier] ?? TIER_COLORS.OTHER
          return (
            <div
              key={t.gpuTier}
              title={`${t.gpuTier} - ${t.count} (${pct.toFixed(1)}%)`}
              style={{ width: `${pct}%`, background: color }}
            />
          )
        })}
      </div>
      <div className="space-y-1.5">
        {tiers.map(t => {
          const pct = (t.count / total) * 100
          const color = TIER_COLORS[t.gpuTier] ?? TIER_COLORS.OTHER
          return (
            <div key={t.gpuTier} className="flex items-center gap-2 text-sm">
              <span
                className="font-mono text-[10px] px-2 py-0.5 rounded-sm"
                style={{ background: `${color}22`, color, border: `1px solid ${color}55` }}
              >
                {t.gpuTier}
              </span>
              <span className="flex-1 font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {pct.toFixed(0)}%
              </span>
              <span className="font-mono text-sm" style={{ color: 'var(--text-primary)' }}>
                {t.count}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PerNodeEarningsList({ nodes }: { nodes: PerNodeEarnings[] }) {
  if (nodes.length === 0) {
    return (
      <div className="text-center py-6">
        <Server size={28} style={{ color: 'var(--text-muted)', margin: '0 auto 12px' }} />
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No node earnings yet.</p>
      </div>
    )
  }
  const max = nodes.reduce((m, n) => Math.max(m, n.earnings), 0)
  return (
    <div className="space-y-3">
      {nodes.slice(0, 8).map(n => {
        const ratio = max > 0 ? (n.earnings / max) * 100 : 0
        return (
          <div key={n.nodeId} className="flex items-center gap-3 text-sm">
            <Link
              href={`/nodes/${n.nodeId}`}
              className="font-mono text-[12px] truncate flex-1 hover:underline"
              style={{ color: 'var(--text-secondary)' }}
              title={n.label}
            >
              {n.label}
            </Link>
            <div className="flex-1 h-2 rounded-sm overflow-hidden" style={{ background: 'var(--border-color)' }}>
              <div
                className="h-full transition-all"
                style={{ width: `${ratio}%`, background: 'var(--primary)' }}
              />
            </div>
            <span className="font-mono text-sm w-20 text-right" style={{ color: 'var(--text-primary)' }}>
              {formatCurrency(n.earnings)}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function RecentPayoutsTable({ payouts }: { payouts: RecentPayout[] }) {
  if (payouts.length === 0) {
    return (
      <div className="text-center py-6">
        <Wallet size={28} style={{ color: 'var(--text-muted)', margin: '0 auto 12px' }} />
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No payouts yet.</p>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      {payouts.map(p => (
        <div
          key={p.id}
          className="flex items-center justify-between gap-3 text-sm rounded-md px-3 py-2"
          style={{ background: 'var(--surface-elevated)', border: '1px solid var(--border-color)' }}
        >
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              {new Date(p.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </p>
            <p className="font-display text-sm" style={{ color: 'var(--text-primary)' }}>
              {formatCurrency(p.amount)}
            </p>
          </div>
          {p.txHash ? (
            <a
              href={`https://solscan.io/tx/${p.txHash}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-mono text-[11px] hover:underline"
              style={{ color: 'var(--primary)' }}
            >
              View tx <ExternalLink size={11} />
            </a>
          ) : (
            <span className="font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>{p.status}</span>
          )}
        </div>
      ))}
      <Link
        href="/payouts"
        className="inline-flex items-center gap-1 mt-1 font-mono text-[11px] hover:underline"
        style={{ color: 'var(--primary)' }}
      >
        View all payouts <ExternalLink size={11} />
      </Link>
    </div>
  )
}

// C3 wave 2: shape of /v1/portal/node-runner/earnings/forecast response.
interface ForecastData {
  projected: number
  rangeLow: number
  rangeHigh: number
  avgDailyEarnings: number
  daysAnalyzed: number
  basedOn: string
  horizonDays: number
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [ops, setOps] = useState<OperatorStatsData | null>(null)
  const [forecast, setForecast] = useState<ForecastData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const loadData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    try {
      const [d, o, f] = await Promise.all([
        nodeRunner.dashboard() as Promise<DashboardData>,
        nodeRunner.operatorStats() as Promise<OperatorStatsData>,
        // Forecast failure is non-fatal (cold-start / no earnings yet).
        // Swallow per-promise so a 404 here doesn't blank the dashboard.
        nodeRunner.earningsForecast(30).catch(() => null) as Promise<ForecastData | null>,
      ])
      setData(d)
      setOps(o)
      setForecast(f)
    } catch { /* silent */ }
    finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    loadData()
    const interval = setInterval(() => loadData(), 15_000)
    return () => clearInterval(interval)
  }, [loadData])

  const handleNodeEvent = useCallback(() => { loadData() }, [loadData])
  useWebSocket({
    events: {
      'node:statusChange': handleNodeEvent,
      'node:offline':      handleNodeEvent,
      'node:registered':   handleNodeEvent,
      'job:completed':     handleNodeEvent,
      'job:failed':        handleNodeEvent,
    },
  })

  const nodeStatusData = useMemo(() => {
    if (!data) return []
    const entries: { name: string; value: number; color: string }[] = []
    if (data.nodes.online > 0)              entries.push({ name: 'Online',      value: data.nodes.online,            color: NODE_STATUS_COLORS.Online })
    if (data.nodes.offline > 0)             entries.push({ name: 'Offline',     value: data.nodes.offline,           color: NODE_STATUS_COLORS.Offline })
    if (data.nodes.maintenance > 0)         entries.push({ name: 'Maintenance', value: data.nodes.maintenance,       color: NODE_STATUS_COLORS.Maintenance })
    if ((data.nodes.paused ?? 0) > 0)       entries.push({ name: 'Paused',      value: data.nodes.paused ?? 0,       color: NODE_STATUS_COLORS.Paused })
    if ((data.nodes.inUse ?? 0) > 0)        entries.push({ name: 'In Use',      value: data.nodes.inUse ?? 0,        color: NODE_STATUS_COLORS['In Use'] })
    return entries
  }, [data])

  const dailyEarningsData = useMemo(() => {
    if (!data?.dailyEarnings?.length) {
      const days: { date: string; amount: number; isToday: boolean }[] = []
      const now = new Date()
      const todayKey = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      for (let i = 29; i >= 0; i--) {
        const d = new Date(now)
        d.setDate(d.getDate() - i)
        const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        days.push({ date: label, amount: 0, isToday: label === todayKey })
      }
      return days
    }
    const todayKey = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    return data.dailyEarnings.map((e) => {
      const label = new Date(e.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      return { date: label, amount: e.amount, isToday: label === todayKey }
    })
  }, [data])

  // Summary KPIs for the chart header — total, avg over active days,
  // and best single day. Active days = days with non-zero earnings, so
  // the average isn't dragged down by all the offline days inside the
  // 30-day window.
  const earningsSummary = useMemo(() => {
    const days = data?.dailyEarnings ?? []
    const totals = days.reduce((acc, d) => acc + d.amount, 0)
    const activeDays = days.filter((d) => d.amount > 0)
    const avg = activeDays.length > 0 ? totals / activeDays.length : 0
    const best = days.reduce<{ date: string; amount: number } | null>(
      (acc, d) => (d.amount > (acc?.amount ?? 0) ? d : acc),
      null,
    )
    return {
      total: totals,
      avg,
      activeCount: activeDays.length,
      best: best && best.amount > 0 ? best : null,
    }
  }, [data])

  // Week-over-week trend for the forecast card — last 7 days avg vs
  // the prior 7 days avg. Drives the up/down/flat chip next to the
  // headline. Both averages compute over active (non-zero) days only
  // so a recent string of zeros doesn't make the trend read negative.
  const forecastTrend = useMemo(() => {
    const days = data?.dailyEarnings ?? []
    if (days.length < 14) return null
    const last7 = days.slice(-7).filter((d) => d.amount > 0)
    const prior7 = days.slice(-14, -7).filter((d) => d.amount > 0)
    if (last7.length === 0 || prior7.length === 0) return null
    const lastAvg = last7.reduce((a, d) => a + d.amount, 0) / last7.length
    const priorAvg = prior7.reduce((a, d) => a + d.amount, 0) / prior7.length
    const deltaPct = ((lastAvg - priorAvg) / priorAvg) * 100
    return { lastAvg, priorAvg, deltaPct }
  }, [data])

  // 7-day sparkline data for the forecast card. Last 7 days from the
  // dashboard endpoint, mapped to the shape recharts expects.
  const forecastSparkline = useMemo(() => {
    const days = data?.dailyEarnings ?? []
    return days.slice(-7).map((d) => ({ date: d.date, amount: d.amount }))
  }, [data])

  if (loading) {
    return <A2ELoader fullScreen={false} message="Loading your dashboard" />
  }

  const onlinePct = data && data.nodes.total > 0
    ? (data.nodes.online / data.nodes.total) * 100
    : 0
  const utilizationPct = data && data.nodes.online > 0
    ? ((data.nodes.inUse ?? 0) / data.nodes.online) * 100
    : 0

  const tierColor = ops ? TIER_TONE[ops.reputationTier] : '#94a3b8'

  return (
    <DashboardShell
      title="Node Runner Dashboard"
      subtitle="Operator side"
      liveLabel="LIVE"
      onRefresh={() => loadData(true)}
      refreshing={refreshing}
    >
      <DashboardMainColumn>
        {/* Policy banner: explains the current admin-approved
            withdrawal flow so operators know when to expect funds
            after requesting a payout. */}
        <AutomaticSettlementBanner />

        {/* Earnings + nodes + jobs */}
        <MetricTriad
          metrics={[
            {
              label: 'Earnings (30d)',
              value: formatCurrency(data?.earnings.month ?? 0),
              detail: `Today ${formatCurrency(data?.earnings.today ?? 0)}`,
              icon: DollarSign,
              tone: 'green',
              // Clicking the Earnings card lands on the Earnings
              // dashboard (period-scoped reporting). Withdraw flow
              // is reached via the dedicated balance pill / Payouts.
              href: '/earnings',
            },
            {
              label: 'Nodes Online',
              value: `${data?.nodes.online ?? 0} / ${data?.nodes.total ?? 0}`,
              detail: `Renting now: ${data?.nodes.inUse ?? 0}`,
              icon: Server,
              tone: 'cyan',
              href: '/nodes',
            },
            {
              label: 'Jobs',
              value: `${data?.jobs.completed ?? 0}`,
              detail: `Running: ${data?.jobs.running ?? 0}`,
              icon: Activity,
              tone: 'purple',
              href: '/jobs',
            },
          ]}
        />

        {/* Operator stats: payout + capital + rank + streak */}
        {ops && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <OperatorStatTile
              label="Pending Payout"
              value={formatCurrencyShort(ops.pendingPayout)}
              sub="Tap to withdraw"
              icon={PiggyBank}
              tone="#22c55e"
              href="/payouts/settings"
            />
            <OperatorStatTile
              label="Capital Deployed"
              value={formatCurrencyShort(ops.capitalDeployed)}
              sub="Cost basis"
              icon={Building2}
              tone="#06b6d4"
            />
            <OperatorStatTile
              label="Leaderboard"
              value={ops.totalRanked > 0 ? `#${ops.leaderboardRank}` : '-'}
              sub={ops.totalRanked > 0 ? `of ${ops.totalRanked} - ${ops.reputationTier}` : 'Not ranked'}
              icon={Trophy}
              tone={tierColor}
            />
            <OperatorStatTile
              label="Uptime Streak"
              value={`${ops.uptimeStreak}d`}
              sub={ops.uptimeStreak === 1 ? 'Day in a row' : 'Days in a row'}
              icon={Flame}
              tone="#f97316"
            />
          </div>
        )}

        {/* C3 wave 2: forecast card. Forward-looking 30-day projection
            from the last 7 active earning days. Hidden until the
            operator has 5+ days of data so cold-start doesn't show a
            misleading "$0 projected". */}
        {forecast && (
          <SectionCard title="Earnings forecast (next 30 days)" icon={TrendingUp}>
            {forecast.daysAnalyzed < 5 ? (
              <div className="py-4">
                <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                  Not enough recent earnings data yet to forecast.
                </p>
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  Forecast unlocks after 5 active earning days. Today: {forecast.daysAnalyzed} {forecast.daysAnalyzed === 1 ? 'day' : 'days'}.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Top row: headline + trend chip + sparkline. The
                    sparkline reads from the last 7 days of dailyEarnings
                    so it visualizes the actual numbers feeding the
                    forecast — operator can see at a glance whether the
                    projection is built on a rising or falling trend.
                    Responsive: on <sm the sparkline drops below the
                    headline so the number stays the dominant element;
                    on >=sm it sits right of the headline, vertically
                    centered with it, with breathing room around the
                    curve so it doesn't read as clipped. */}
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-3 flex-wrap">
                      <p className="text-4xl sm:text-5xl font-bold font-mono leading-none tracking-tight" style={{ color: 'var(--primary)' }}>
                        ${forecast.projected.toFixed(2)}
                      </p>
                      {forecastTrend && (
                        <ForecastTrendChip deltaPct={forecastTrend.deltaPct} />
                      )}
                    </div>
                    <p className="text-xs mt-2 font-mono uppercase tracking-[0.16em]" style={{ color: 'var(--text-muted)' }}>
                      Projected · next 30 days
                    </p>
                  </div>
                  {forecastSparkline.length > 1 && (
                    <div
                      className="shrink-0 self-stretch sm:self-center w-full sm:w-40 h-14 rounded-md px-1.5 py-1"
                      style={{
                        background: 'rgba(34, 197, 94, 0.04)',
                        border: '1px solid rgba(34, 197, 94, 0.10)',
                      }}
                      aria-label="Last 7 days earnings trend"
                    >
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={forecastSparkline} margin={{ top: 2, right: 4, bottom: 2, left: 4 }}>
                          <defs>
                            <linearGradient id="forecastSparkFill" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.55} />
                              <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <Area
                            type="monotone"
                            dataKey="amount"
                            stroke="var(--primary)"
                            strokeWidth={1.75}
                            fill="url(#forecastSparkFill)"
                            isAnimationActive={false}
                            dot={false}
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </div>

                {/* Range bar — horizontal visualization of the ±15%
                    band with the projected value marked. Reads faster
                    than the comma-separated low/high text the previous
                    version used. */}
                <ForecastRangeBar
                  low={forecast.rangeLow}
                  projected={forecast.projected}
                  high={forecast.rangeHigh}
                />

                {/* Stats row: active days + daily average. Small
                    monospaced strip so the methodology stays glanceable
                    without expanding the details. */}
                <div className="flex items-center gap-4 pt-1 text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                  <span className="flex items-center gap-1.5">
                    <Sparkles size={12} style={{ color: 'var(--primary)' }} />
                    {forecast.daysAnalyzed} active {forecast.daysAnalyzed === 1 ? 'day' : 'days'}
                  </span>
                  <span style={{ color: 'var(--border-color)' }}>·</span>
                  <span>${forecast.avgDailyEarnings.toFixed(2)}/day avg</span>
                </div>

                <details className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  <summary className="cursor-pointer select-none" style={{ color: 'var(--text-secondary)' }}>
                    How is this calculated?
                  </summary>
                  <p className="mt-2 leading-relaxed">
                    Based on the {forecast.basedOn} ({forecast.daysAnalyzed} active days,
                    avg <span className="font-mono">${forecast.avgDailyEarnings.toFixed(2)}/day</span>).
                    Projected forward {forecast.horizonDays} days with a conservative ±15% band.
                    Real earnings will vary with rental demand, uptime, and price changes.
                  </p>
                </details>
              </div>
            )}
          </SectionCard>
        )}

        {/* Daily earnings bar chart with summary KPI strip on top */}
        <SectionCard title="Earnings, last 30 days" icon={Zap}>
          {earningsSummary.total > 0 && (
            /* KPI summary strip: stacks 1-up on narrow viewports so each
                stat keeps room for its full mono value, then promotes
                to a 3-column row on sm+ where the SectionCard is wide
                enough for them to share. The divider stays on the
                bottom edge regardless of orientation. */
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4 pb-4" style={{ borderBottom: '1px solid var(--border-color)' }}>
              <ChartSummaryStat label="Total (30d)" value={`$${earningsSummary.total.toFixed(2)}`} />
              <ChartSummaryStat label={`Avg / day · ${earningsSummary.activeCount} active`} value={`$${earningsSummary.avg.toFixed(2)}`} />
              <ChartSummaryStat
                label="Best day"
                value={earningsSummary.best ? `$${earningsSummary.best.amount.toFixed(2)}` : '—'}
                sub={earningsSummary.best?.date}
              />
            </div>
          )}
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dailyEarningsData} margin={{ top: 10, right: 12, bottom: 0, left: -12 }}>
                <defs>
                  <linearGradient id="earningsBarFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.95} />
                    <stop offset="100%" stopColor="var(--primary)" stopOpacity={0.45} />
                  </linearGradient>
                  <linearGradient id="earningsBarFillToday" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#86efac" stopOpacity={1} />
                    <stop offset="100%" stopColor="var(--primary)" stopOpacity={0.6} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--border-color)" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fill: 'var(--text-muted)', fontSize: 11, fontFamily: 'var(--font-jetbrains)' }}
                  tickLine={false}
                  axisLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fill: 'var(--text-muted)', fontSize: 11, fontFamily: 'var(--font-jetbrains)' }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(0)}`}
                />
                <Tooltip cursor={{ fill: 'rgba(34,197,94,0.08)' }} content={<EarningsBarTooltip />} />
                <Bar dataKey="amount" radius={[4, 4, 0, 0]}>
                  {dailyEarningsData.map((entry, idx) => (
                    <Cell
                      key={`cell-${idx}`}
                      fill={entry.isToday ? 'url(#earningsBarFillToday)' : 'url(#earningsBarFill)'}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </SectionCard>

        {/* Forward-looking payout schedule (full width) */}
        <PayoutScheduleCard payouts={ops?.upcomingPayouts ?? []} />

        {/* Per-node earnings (full width) */}
        <SectionCard title="Earnings by Node" icon={Server}>
          <PerNodeEarningsList nodes={ops?.perNodeEarnings ?? []} />
        </SectionCard>

        {/* Fleet composition: status donut + GPU tier breakdown */}
        <SectionCard title="Fleet Composition" icon={Cpu}>
          {nodeStatusData.length === 0 ? (
            <div className="text-center py-8">
              <Server size={32} style={{ color: 'var(--text-muted)', margin: '0 auto 12px' }} />
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No nodes registered yet</p>
              <Link
                href="/deploy"
                className="inline-flex items-center gap-1 mt-4 px-4 h-9 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent-hover transition-colors"
              >
                <Plus size={14} /> Add a node
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_1px_1fr] gap-6 items-stretch">
              {/* Left: Status donut + status legend */}
              <div className="flex flex-col">
                <p className="font-mono text-[10px] tracking-[0.14em] uppercase mb-3" style={{ color: 'var(--text-muted)' }}>
                  Status mix
                </p>
                <div className="flex items-center gap-4">
                  <div className="h-36 w-36 relative shrink-0">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={nodeStatusData}
                          innerRadius={38}
                          outerRadius={64}
                          paddingAngle={2}
                          dataKey="value"
                        >
                          {nodeStatusData.map((entry) => (
                            <Cell key={entry.name} fill={entry.color} stroke="transparent" />
                          ))}
                        </Pie>
                        <Tooltip content={<ChartTooltip />} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                      <span className="font-display text-2xl" style={{ color: 'var(--text-primary)' }}>
                        {data?.nodes.total ?? 0}
                      </span>
                      <span className="font-mono text-[10px] tracking-[0.14em] uppercase" style={{ color: 'var(--text-muted)' }}>
                        Total
                      </span>
                    </div>
                  </div>
                  <div className="flex-1 min-w-0 space-y-1.5">
                    {nodeStatusData.map((entry) => (
                      <div key={entry.name} className="flex items-center gap-2 text-sm">
                        <span className="w-2 h-2 rounded-sm" style={{ background: entry.color }} />
                        <span className="flex-1 font-mono text-[11px] truncate" style={{ color: 'var(--text-secondary)' }}>
                          {entry.name}
                        </span>
                        <span className="font-mono text-sm" style={{ color: 'var(--text-primary)' }}>
                          {entry.value}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Vertical divider on lg+ */}
              <div className="hidden lg:block w-px self-stretch" style={{ background: 'var(--border-color)' }} />

              {/* Right: GPU tier breakdown */}
              <div className="flex flex-col">
                <p className="font-mono text-[10px] tracking-[0.14em] uppercase mb-3" style={{ color: 'var(--text-muted)' }}>
                  GPU tier breakdown
                </p>
                {ops && ops.nodesByTier && ops.nodesByTier.length > 0 ? (
                  <TierBreakdown tiers={ops.nodesByTier} total={data?.nodes.total ?? 0} />
                ) : (
                  <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No tier data yet.</p>
                )}
              </div>
            </div>
          )}
        </SectionCard>

        {/* Recent payouts list */}
        <SectionCard title="Recent Payouts" icon={Wallet}>
          <RecentPayoutsTable payouts={ops?.recentPayouts ?? []} />
        </SectionCard>
      </DashboardMainColumn>

      <DashboardRightRail>
        <ClockCard />

        <QuickActions
          actions={[
            { label: 'Add Node',  href: '/deploy',      icon: Plus, emphasis: true },
            { label: 'Nodes',     href: '/nodes',       icon: Server },
            { label: 'Earnings',  href: '/earnings',    icon: DollarSign },
            { label: 'Withdraw',  href: '/withdrawals', icon: ArrowDownToLine },
          ]}
        />

        <ResourceAllocation
          title="Network Health"
          bars={[
            {
              label: 'Uptime (30d)',
              value: data?.uptimePercent ?? 0,
              tone: 'green',
              detail: `${(data?.uptimePercent ?? 0).toFixed(1)}%`,
            },
            {
              label: 'Online ratio',
              value: onlinePct,
              tone: 'cyan',
              detail: `${data?.nodes.online ?? 0} / ${data?.nodes.total ?? 0}`,
            },
            {
              label: 'Utilization',
              value: utilizationPct,
              tone: 'purple',
              detail: `${data?.nodes.inUse ?? 0} renting`,
            },
          ]}
        />

        <SectionCard title="Paid Out" icon={Wallet}>
          <p className="font-mono text-[11px] mb-2" style={{ color: 'var(--text-muted)' }}>
            Lifetime payouts
          </p>
          <div className="font-display text-2xl tracking-tight" style={{ color: 'var(--text-primary)' }}>
            {formatCurrency(data?.totalPaidOut ?? 0)}
          </div>
          <p className="text-xs mt-2 flex items-center gap-1" style={{ color: 'var(--text-secondary)' }}>
            <Globe size={12} /> Settlement on Solana
          </p>
        </SectionCard>
      </DashboardRightRail>
    </DashboardShell>
  )
}
