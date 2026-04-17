'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import {
  PieChart, Pie, Cell, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid
} from 'recharts'
import {
  LayoutDashboard,
  DollarSign,
  Server,
  Activity,
  Zap,
  Wallet,
  Cpu,
  Clock,
  RefreshCw,
  PauseCircle,
  PlayCircle,
  Plus,
} from 'lucide-react'
import { nodeRunner } from '@/lib/api'
import { Skeleton } from '@/components/ui/Skeleton'
import { useToast } from '@/components/ui/Toast'
import { useWebSocket } from '@/hooks/useWebSocket'

/* -----------------------------------------------
   Types
   ----------------------------------------------- */

interface DashboardData {
  earnings: { today: number; week: number; month: number; allTime: number }
  nodes: { total: number; online: number; offline: number; maintenance: number; paused?: number; inUse?: number }
  jobs: { completed: number; running: number }
  totalPaidOut: number
  uptimePercent: number
  dailyEarnings?: { date: string; amount: number }[]
}

type Period = 'today' | 'week' | 'month' | 'allTime'

/* -----------------------------------------------
   Animation Variants
   ----------------------------------------------- */

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.05 },
  },
}

const itemVariants = {
  hidden: { opacity: 0, y: 15 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.3, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] },
  },
}

/* -----------------------------------------------
   Chart colours
   ----------------------------------------------- */

const NODE_STATUS_COLORS: Record<string, string> = {
  online: '#22c55e',
  offline: '#ef4444',
  maintenance: '#f59e0b',
  paused: '#3b82f6',
  inUse: '#6366f1',
}

/* -----------------------------------------------
   Helpers
   ----------------------------------------------- */

const formatCurrency = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)

const formatCompact = (n: number) => {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 10_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K'
  return n.toLocaleString()
}

/* -----------------------------------------------
   Custom Tooltip (shared by all recharts)
   ----------------------------------------------- */

interface TooltipPayloadItem {
  name: string
  value: number
  color?: string
}

function ChartTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayloadItem[] }) {
  if (!active || !payload?.length) return null
  return (
    <div className="dash-tooltip">
      <p className="dash-tooltip-label">{payload[0].name}</p>
      <p className="dash-tooltip-value">
        {typeof payload[0].value === 'number' ? payload[0].value.toLocaleString() : payload[0].value}
      </p>
    </div>
  )
}

/* -----------------------------------------------
   Page Component
   ----------------------------------------------- */

export default function DashboardPage() {
  const { toast } = useToast()
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [period, setPeriod] = useState<Period>('month')
  const [actionLoading, setActionLoading] = useState(false)

  const loadData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    try {
      const d = (await nodeRunner.dashboard()) as DashboardData
      setData(d)
    } catch {
      /* silently fail — user sees stale data or loading state */
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    loadData()
    const interval = setInterval(() => loadData(), 15_000)
    return () => clearInterval(interval)
  }, [loadData])

  /* WebSocket real-time updates */
  const handleNodeEvent = useCallback(() => { loadData() }, [loadData])
  useWebSocket({
    events: {
      'node:statusChange': handleNodeEvent,
      'node:offline': handleNodeEvent,
      'node:registered': handleNodeEvent,
      'job:completed': handleNodeEvent,
      'job:failed': handleNodeEvent,
    },
  })

  /* ---- Computed chart data ---- */

  const nodeStatusData = useMemo(() => {
    if (!data) return []
    const entries: { name: string; value: number; color: string }[] = []
    if (data.nodes.online > 0) entries.push({ name: 'Online', value: data.nodes.online, color: NODE_STATUS_COLORS.online })
    if (data.nodes.offline > 0) entries.push({ name: 'Offline', value: data.nodes.offline, color: NODE_STATUS_COLORS.offline })
    if (data.nodes.maintenance > 0) entries.push({ name: 'Maintenance', value: data.nodes.maintenance, color: NODE_STATUS_COLORS.maintenance })
    if ((data.nodes.paused ?? 0) > 0) entries.push({ name: 'Paused', value: data.nodes.paused ?? 0, color: NODE_STATUS_COLORS.paused })
    if ((data.nodes.inUse ?? 0) > 0) entries.push({ name: 'In Use', value: data.nodes.inUse ?? 0, color: NODE_STATUS_COLORS.inUse })
    return entries
  }, [data])

  const dailyEarningsData = useMemo(() => {
    if (!data?.dailyEarnings?.length) {
      // Generate placeholder last-30-day data from what we know
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

  const earningsValue = data?.earnings[period] ?? 0

  /* ---- Loading state ---- */

  if (loading) {
    return (
      <div className="space-y-6 animate-fadeIn">
        <Skeleton className="h-14 w-full" />
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Skeleton className="h-72" />
          <Skeleton className="h-72" />
        </div>
        <Skeleton className="h-80 w-full" />
      </div>
    )
  }

  /* ---- Stat block definitions ---- */

  const stats: {
    label: string
    value: string
    icon: React.ReactNode
    colorClass: string
  }[] = [
    {
      label: 'Total Earnings',
      value: formatCurrency(data?.earnings.allTime ?? 0),
      icon: <DollarSign size={18} />,
      colorClass: 'green',
    },
    {
      label: 'Active Nodes',
      value: `${data?.nodes.online ?? 0}/${data?.nodes.total ?? 0}`,
      icon: <Server size={18} />,
      colorClass: 'blue',
    },
    {
      label: 'Uptime %',
      value: `${(data?.uptimePercent ?? 0).toFixed(1)}%`,
      icon: <Activity size={18} />,
      colorClass: 'purple',
    },
    {
      label: 'Nodes In Use',
      value: `${data?.nodes.inUse ?? 0}`,
      icon: <Zap size={18} />,
      colorClass: 'yellow',
    },
    {
      label: 'Total Paid Out',
      value: formatCurrency(data?.totalPaidOut ?? 0),
      icon: <Wallet size={18} />,
      colorClass: 'cyan',
    },
    {
      label: 'Earnings Today',
      value: formatCurrency(data?.earnings.today ?? 0),
      icon: <Cpu size={18} />,
      colorClass: 'orange',
    },
  ]

  /* ---- Render ---- */

  return (
    <motion.div
      className="dashboard-modern"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      {/* ========== Header ========== */}
      <motion.div className="dash-header" variants={itemVariants}>
        <div className="dash-header-left">
          <h1><LayoutDashboard size={28} /> Dashboard</h1>
        </div>
        <div className="dash-header-right">
          <div className="dash-date-badge">
            <Clock size={14} />
            {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
          </div>
          <button
            className="dash-refresh-btn"
            onClick={() => loadData(true)}
            disabled={refreshing}
            title="Refresh data"
          >
            <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
          </button>
        </div>
      </motion.div>

      {/* ========== Stat Blocks ========== */}
      <motion.div className="stat-blocks" variants={containerVariants}>
        {stats.map((s) => (
          <motion.div
            key={s.label}
            className={`stat-block ${s.colorClass}`}
            variants={itemVariants}
          >
            <div className="stat-icon">{s.icon}</div>
            <div className="stat-content">
              <span className="stat-value">{s.value}</span>
              <span className="stat-label">{s.label}</span>
            </div>
          </motion.div>
        ))}
      </motion.div>

      {/* ========== Two-column: Node Status + Earnings Selector ========== */}
      <motion.div className="dash-charts-row" style={{ gridTemplateColumns: '1fr 1fr' }} variants={itemVariants}>
        {/* Node Status Donut */}
        <div className="dash-chart-card">
          <h3 className="dash-chart-title">Node Status</h3>
          {nodeStatusData.length > 0 ? (
            <div className="dash-chart-with-legend">
              <div className="dash-pie-container">
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie
                      data={nodeStatusData}
                      cx="50%"
                      cy="50%"
                      innerRadius={50}
                      outerRadius={78}
                      paddingAngle={2}
                      dataKey="value"
                    >
                      {nodeStatusData.map((entry, i) => (
                        <Cell key={i} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip content={<ChartTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="dash-donut-center">
                  <span className="dash-donut-value">{data?.nodes.total ?? 0}</span>
                  <span className="dash-donut-label">Total</span>
                </div>
              </div>
              <div className="dash-chart-legend">
                {nodeStatusData.map((item, i) => (
                  <div key={i} className="dash-legend-item">
                    <span className="dash-legend-color" style={{ background: item.color }} />
                    <span className="dash-legend-label">{item.name}</span>
                    <span className="dash-legend-value">{item.value}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="dash-chart-empty">No node data available</div>
          )}
        </div>

        {/* Earnings Period Selector */}
        <div className="dash-chart-card" style={{ display: 'flex', flexDirection: 'column' }}>
          <h3 className="dash-chart-title">Earnings</h3>

          {/* Period pills */}
          <div style={{ display: 'flex', gap: '4px', padding: '4px', background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-md)', marginBottom: 'var(--space-lg)', width: 'fit-content' }}>
            {(['today', 'week', 'month', 'allTime'] as Period[]).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                  period === p
                    ? 'text-white'
                    : ''
                }`}
                style={{
                  background: period === p ? 'var(--primary)' : 'transparent',
                  color: period === p ? '#fff' : 'var(--text-muted)',
                }}
              >
                {p === 'allTime' ? 'All Time' : p.charAt(0).toUpperCase() + p.slice(1)}
              </button>
            ))}
          </div>

          {/* Big number */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <span style={{ fontSize: '2.75rem', fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.1 }}>
              {formatCurrency(earningsValue)}
            </span>
            <span style={{ fontSize: '0.875rem', color: 'var(--text-muted)', marginTop: 'var(--space-sm)' }}>
              {period === 'today'
                ? 'Earned today'
                : period === 'week'
                ? 'Last 7 days'
                : period === 'month'
                ? 'Last 30 days'
                : 'Lifetime earnings'}
            </span>
          </div>
        </div>
      </motion.div>

      {/* ========== Daily Earnings Bar Chart (full width) ========== */}
      <motion.div variants={itemVariants}>
        <div className="dash-chart-card">
          <h3 className="dash-chart-title">Daily Earnings (Last 30 Days)</h3>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={dailyEarningsData} margin={{ left: 10, right: 10, top: 10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.1} />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                tickFormatter={(v: number) => `$${v}`}
              />
              <Tooltip
                contentStyle={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '8px',
                  color: 'var(--text-primary)',
                }}
                formatter={(value) => [`$${Number(value).toFixed(2)}`, 'Earnings']}
              />
              <Bar dataKey="amount" fill="#22c55e" name="Earnings" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </motion.div>

      {/* ========== Quick Actions ========== */}
      <motion.div variants={itemVariants}>
        <div className="dash-chart-card">
          <h3 className="dash-chart-title">Quick Actions</h3>
          <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
            <Link href="/deploy">
              <button className="btn btn-primary">
                <Plus size={16} />
                Deploy New Node
              </button>
            </Link>
            <button className="btn btn-secondary" disabled={actionLoading} onClick={async () => {
              setActionLoading(true)
              try {
                const res = await nodeRunner.pauseAll()
                toast('success', res.message)
                loadData(true)
              } catch (e) { toast('error', e instanceof Error ? e.message : 'Failed') }
              finally { setActionLoading(false) }
            }}>
              <PauseCircle size={16} />
              Pause All
            </button>
            <button className="btn btn-secondary" disabled={actionLoading} onClick={async () => {
              setActionLoading(true)
              try {
                const res = await nodeRunner.resumeAll()
                toast('success', res.message)
                loadData(true)
              } catch (e) { toast('error', e instanceof Error ? e.message : 'Failed') }
              finally { setActionLoading(false) }
            }}>
              <PlayCircle size={16} />
              Resume All
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}
