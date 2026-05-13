'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer,
  PieChart, Pie, Cell,
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
}

const NODE_STATUS_COLORS: Record<string, string> = {
  Online:      '#22c55e',
  Offline:     '#ef4444',
  Maintenance: '#f59e0b',
  Paused:      '#3b82f6',
  'In Use':    '#8b5cf6',
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

// ---------------------------------------------------------------------
// Sub-components for the new operator analytics row.
// Pulled inline (not in FuturisticShell) because they consume the
// operator-stats response directly and are dashboard-specific.
// ---------------------------------------------------------------------

function OperatorStatTile({
  label, value, sub, icon: Icon, tone,
}: {
  label: string
  value: string
  sub?: string
  icon: typeof DollarSign
  tone: string
}) {
  return (
    <div
      className="rounded-md p-3 flex items-start gap-3"
      style={{
        background: 'var(--glass-bg)',
        border: '1px solid var(--glass-border)',
        backdropFilter: 'blur(var(--glass-blur, 16px))',
      }}
    >
      <div
        className="w-9 h-9 shrink-0 rounded-md flex items-center justify-center"
        style={{ background: `${tone}1a`, border: `1px solid ${tone}55` }}
      >
        <Icon size={16} style={{ color: tone }} />
      </div>
      <div className="min-w-0 flex-1">
        <p
          className="font-mono text-[10px] tracking-[0.14em] uppercase truncate"
          style={{ color: 'var(--text-muted)' }}
        >
          {label}
        </p>
        <p
          className="font-display text-lg leading-tight truncate"
          style={{ color: 'var(--text-primary)' }}
        >
          {value}
        </p>
        {sub && (
          <p className="font-mono text-[11px] truncate" style={{ color: 'var(--text-secondary)' }}>
            {sub}
          </p>
        )}
      </div>
    </div>
  )
}

function PayoutCalendar({ entries }: { entries: PayoutCalendarEntry[] }) {
  const max = useMemo(
    () => entries.reduce((m, e) => Math.max(m, e.amount), 0),
    [entries],
  )
  if (entries.length === 0) {
    return <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No payout data yet.</p>
  }
  return (
    <div>
      <div className="grid grid-cols-15 gap-1.5" style={{ gridTemplateColumns: 'repeat(15, minmax(0, 1fr))' }}>
        {entries.map((e) => {
          const ratio = max > 0 ? e.amount / max : 0
          const opacity = e.amount > 0 ? 0.25 + ratio * 0.75 : 0.08
          const isToday = e.date === new Date().toISOString().slice(0, 10)
          return (
            <div
              key={e.date}
              title={`${formatDateShort(e.date)} - ${formatCurrency(e.amount)}`}
              className="aspect-square rounded-sm"
              style={{
                background: e.amount > 0 ? `rgba(34,197,94,${opacity})` : 'var(--border-color)',
                outline: isToday ? '1px solid var(--primary)' : 'none',
                outlineOffset: '1px',
              }}
            />
          )
        })}
      </div>
      <div className="flex items-center justify-between mt-3 font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
        <span>{formatDateShort(entries[0].date)}</span>
        <span className="flex items-center gap-1.5">
          Less
          {[0.1, 0.3, 0.5, 0.75, 1].map(o => (
            <span key={o} className="w-2.5 h-2.5 rounded-sm" style={{ background: `rgba(34,197,94,${o})` }} />
          ))}
          More
        </span>
        <span>{formatDateShort(entries[entries.length - 1].date)}</span>
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

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [ops, setOps] = useState<OperatorStatsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const loadData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    try {
      const [d, o] = await Promise.all([
        nodeRunner.dashboard() as Promise<DashboardData>,
        nodeRunner.operatorStats() as Promise<OperatorStatsData>,
      ])
      setData(d)
      setOps(o)
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
      const days: { date: string; amount: number }[] = []
      const now = new Date()
      for (let i = 29; i >= 0; i--) {
        const d = new Date(now)
        d.setDate(d.getDate() - i)
        days.push({
          date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          amount: 0,
        })
      }
      return days
    }
    return data.dailyEarnings.map((e) => ({
      date: new Date(e.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      amount: e.amount,
    }))
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
        {/* Earnings + nodes + jobs */}
        <MetricTriad
          metrics={[
            {
              label: 'Earnings (30d)',
              value: formatCurrency(data?.earnings.month ?? 0),
              detail: `Today ${formatCurrency(data?.earnings.today ?? 0)}`,
              icon: DollarSign,
              tone: 'green',
            },
            {
              label: 'Nodes Online',
              value: `${data?.nodes.online ?? 0} / ${data?.nodes.total ?? 0}`,
              detail: `Renting now: ${data?.nodes.inUse ?? 0}`,
              icon: Server,
              tone: 'cyan',
            },
            {
              label: 'Jobs',
              value: `${data?.jobs.completed ?? 0}`,
              detail: `Running: ${data?.jobs.running ?? 0}`,
              icon: Activity,
              tone: 'purple',
            },
          ]}
        />

        {/* Operator stats: payout + capital + rank + streak */}
        {ops && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <OperatorStatTile
              label="Pending Payout"
              value={formatCurrencyShort(ops.pendingPayout)}
              sub="Withdraw-ready"
              icon={PiggyBank}
              tone="#22c55e"
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

        {/* Daily earnings bar chart */}
        <SectionCard title="Earnings, last 30 days" icon={Zap}>
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dailyEarningsData} margin={{ top: 10, right: 12, bottom: 0, left: -12 }}>
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
                />
                <Tooltip cursor={{ fill: 'rgba(34,197,94,0.1)' }} content={<ChartTooltip />} />
                <Bar dataKey="amount" fill="var(--primary)" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </SectionCard>

        {/* Payout calendar + per-node earnings, paired side-by-side on lg+ */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <SectionCard title="Payout Calendar (30d)" icon={CalendarDays}>
            <PayoutCalendar entries={ops?.payoutCalendar ?? []} />
          </SectionCard>

          <SectionCard title="Earnings by Node" icon={Server}>
            <PerNodeEarningsList nodes={ops?.perNodeEarnings ?? []} />
          </SectionCard>
        </div>

        {/* Nodes status mix */}
        <SectionCard title="Node Status Mix" icon={Cpu}>
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
            <div className="flex flex-col sm:flex-row items-center gap-6">
              <div className="h-40 w-40 relative">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={nodeStatusData}
                      innerRadius={40}
                      outerRadius={70}
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
              <div className="flex-1 w-full space-y-2">
                {nodeStatusData.map((entry) => (
                  <div key={entry.name} className="flex items-center gap-3 text-sm">
                    <span className="w-2.5 h-2.5 rounded-sm" style={{ background: entry.color }} />
                    <span className="flex-1 font-mono text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                      {entry.name}
                    </span>
                    <span className="font-mono text-sm" style={{ color: 'var(--text-primary)' }}>
                      {entry.value}
                    </span>
                  </div>
                ))}
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
