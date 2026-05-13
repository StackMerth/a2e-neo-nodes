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

const NODE_STATUS_COLORS: Record<string, string> = {
  Online:      '#22c55e',
  Offline:     '#ef4444',
  Maintenance: '#f59e0b',
  Paused:      '#3b82f6',
  'In Use':    '#8b5cf6',
}

const formatCurrency = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)

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

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const loadData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    try {
      const d = (await nodeRunner.dashboard()) as DashboardData
      setData(d)
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
              detail: `${formatCurrency(data?.earnings.today ?? 0)} today`,
              icon: DollarSign,
              tone: 'green',
            },
            {
              label: 'Nodes Online',
              value: `${data?.nodes.online ?? 0} / ${data?.nodes.total ?? 0}`,
              detail: `${(data?.nodes.inUse ?? 0)} renting now`,
              icon: Server,
              tone: 'cyan',
            },
            {
              label: 'Jobs',
              value: `${data?.jobs.completed ?? 0}`,
              detail: `${data?.jobs.running ?? 0} running`,
              icon: Activity,
              tone: 'purple',
            },
          ]}
        />

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
