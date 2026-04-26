'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { motion } from 'framer-motion'
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip,
} from 'recharts'
import {
  LayoutDashboard,
  Server,
  GitBranch,
  Clock,
  DollarSign,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react'
import { api } from '@/lib/api'
import { SystemHealth } from '@/components/dashboard/SystemHealth'
import { ActivityFeed } from '@/components/dashboard/ActivityFeed'

/* -----------------------------------------------
   Types
   ----------------------------------------------- */

interface Stats {
  nodes: { total: number; byStatus: Record<string, number>; byTier: Record<string, number> }
  jobs: { total: number; last24h: number; byMarket: Record<string, number>; byStatus: Record<string, number> }
  routing: { decisionsLast24h: number; avgDecisionTimeMs: number; byMarket: Record<string, number> }
  earnings: { last24h: { total: number; gpuSeconds: number; jobCount: number } }
}

/* -----------------------------------------------
   Animation Variants
   ----------------------------------------------- */

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.06 },
  },
}

const itemVariants = {
  hidden: { opacity: 0, y: 15 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.35, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] },
  },
}

/* -----------------------------------------------
   Chart colours
   ----------------------------------------------- */

const MARKET_COLORS: Record<string, string> = {
  INTERNAL: '#22c55e',
  AKASH: '#3b82f6',
  IONET: '#8b5cf6',
}

const NODE_STATUS_COLORS: Record<string, string> = {
  ONLINE: '#22c55e',
  OFFLINE: '#ef4444',
  DEGRADED: '#f59e0b',
  PAUSED: '#71717a',
}

/* -----------------------------------------------
   Custom Tooltip
   ----------------------------------------------- */

interface TooltipPayloadItem {
  name: string
  value: number
  payload?: { color?: string }
}

function ChartTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayloadItem[] }) {
  if (!active || !payload?.length) return null
  return (
    <div className="dash-tooltip">
      <p className="dash-tooltip-label">{payload[0].name}</p>
      <p className="dash-tooltip-value">{payload[0].value}</p>
    </div>
  )
}

/* -----------------------------------------------
   Shimmer Skeleton
   ----------------------------------------------- */

function ShimmerBlock({ className }: { className?: string }) {
  return <div className={`animate-shimmer rounded-lg ${className ?? ''}`} />
}

function LoadingSkeleton() {
  return (
    <div className="dashboard-modern" style={{ gap: 'var(--space-lg)' }}>
      <ShimmerBlock className="h-14 w-full" />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--space-md)' }}>
        {[1, 2, 3, 4].map((i) => (
          <ShimmerBlock key={i} className="h-24" />
        ))}
      </div>
      <div className="dash-charts-row">
        <ShimmerBlock className="h-72" />
        <ShimmerBlock className="h-72" />
      </div>
      <ShimmerBlock className="h-48 w-full" />
      <ShimmerBlock className="h-64 w-full" />
    </div>
  )
}

/* -----------------------------------------------
   Page Component
   ----------------------------------------------- */

export default function OverviewPage() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadStats = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    try {
      const data = await api.stats.overview()
      setStats(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load stats')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    loadStats()
    const interval = setInterval(() => loadStats(), 10_000)
    return () => clearInterval(interval)
  }, [loadStats])

  /* -- Computed chart data -- */

  const jobsByMarket = useMemo(() => {
    if (!stats) return []
    return Object.entries(stats.jobs.byMarket)
      .filter(([, count]) => count > 0)
      .map(([market, count]) => ({
        name: market,
        value: count,
        color: MARKET_COLORS[market] ?? '#71717a',
      }))
  }, [stats])

  const totalJobs = useMemo(
    () => jobsByMarket.reduce((sum, s) => sum + s.value, 0),
    [jobsByMarket],
  )

  const nodeStatusData = useMemo(() => {
    if (!stats) return []
    const entries: { name: string; value: number; color: string }[] = []
    const order = ['ONLINE', 'OFFLINE', 'DEGRADED', 'PAUSED']
    const labels: Record<string, string> = { ONLINE: 'Online', OFFLINE: 'Offline', DEGRADED: 'Degraded', PAUSED: 'Paused' }
    order.forEach((key) => {
      const val = stats.nodes.byStatus[key] ?? 0
      if (val > 0) {
        entries.push({ name: labels[key] ?? key, value: val, color: NODE_STATUS_COLORS[key] ?? '#71717a' })
      }
    })
    return entries
  }, [stats])

  /* -- Stat block definitions -- */

  const statBlocks = useMemo(() => {
    if (!stats) return []
    return [
      {
        label: 'Active Nodes',
        value: String(stats.nodes.total),
        icon: <Server size={18} />,
        colorClass: 'green',
      },
      {
        label: 'Routing Decisions 24h',
        value: String(stats.routing.decisionsLast24h),
        icon: <GitBranch size={18} />,
        colorClass: 'blue',
      },
      {
        label: 'Avg Decision Time',
        value: `${stats.routing.avgDecisionTimeMs.toFixed(1)}ms`,
        icon: <Clock size={18} />,
        colorClass: 'purple',
      },
      {
        label: 'Earnings 24h',
        value: `$${stats.earnings.last24h.total.toFixed(2)}`,
        icon: <DollarSign size={18} />,
        colorClass: 'orange',
      },
    ]
  }, [stats])

  /* -- Loading state -- */

  if (loading) {
    return <LoadingSkeleton />
  }

  /* -- Error state -- */

  if (error && !stats) {
    return (
      <div className="dashboard-modern" style={{ justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
        <div className="dash-chart-card" style={{ maxWidth: 420, textAlign: 'center', padding: 'var(--space-xl)' }}>
          <div style={{
            width: 56, height: 56, borderRadius: 'var(--radius-lg)',
            background: 'rgba(239, 68, 68, 0.12)', display: 'flex', alignItems: 'center',
            justifyContent: 'center', margin: '0 auto var(--space-md)',
          }}>
            <AlertTriangle size={28} style={{ color: '#ef4444' }} />
          </div>
          <h2 style={{ fontSize: '1.125rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 'var(--space-sm)' }}>
            Connection Error
          </h2>
          <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', marginBottom: 'var(--space-lg)' }}>
            {error}
          </p>
          <button className="btn btn-primary" onClick={() => loadStats()}>
            Try Again
          </button>
        </div>
      </div>
    )
  }

  /* -- Render -- */

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
          <h1><LayoutDashboard size={28} /> A²E Engine Overview</h1>
        </div>
        <div className="dash-header-right">
          <div className="dash-date-badge">
            <Clock size={14} />
            {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
          </div>
          <button
            className="dash-refresh-btn"
            onClick={() => loadStats(true)}
            disabled={refreshing}
            title="Refresh data"
          >
            <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
          </button>
        </div>
      </motion.div>

      {/* ========== Stat Blocks ========== */}
      <motion.div className="stat-blocks" variants={containerVariants}>
        {statBlocks.map((s) => (
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

      {/* ========== Two-column: Jobs by Market + Node Status ========== */}
      <motion.div className="dash-charts-row" variants={itemVariants}>
        {/* Jobs by Market Donut */}
        <div className="dash-chart-card">
          <h3 className="dash-chart-title">Jobs by Market</h3>
          {jobsByMarket.length > 0 ? (
            <div className="dash-chart-with-legend">
              <div className="dash-pie-container">
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie
                      data={jobsByMarket}
                      cx="50%"
                      cy="50%"
                      innerRadius={50}
                      outerRadius={78}
                      paddingAngle={2}
                      dataKey="value"
                    >
                      {jobsByMarket.map((entry, i) => (
                        <Cell key={i} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip content={<ChartTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="dash-donut-center">
                  <span className="dash-donut-value">{totalJobs}</span>
                  <span className="dash-donut-label">Total</span>
                </div>
              </div>
              <div className="dash-chart-legend">
                {jobsByMarket.map((item, i) => (
                  <div key={i} className="dash-legend-item">
                    <span className="dash-legend-color" style={{ background: item.color }} />
                    <span className="dash-legend-label">{item.name}</span>
                    <span className="dash-legend-value">{item.value}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="dash-chart-empty">No jobs routed yet</div>
          )}
        </div>

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
                  <span className="dash-donut-value">{stats?.nodes.total ?? 0}</span>
                  <span className="dash-donut-label">Nodes</span>
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
            <div className="dash-chart-empty">No nodes registered</div>
          )}
        </div>
      </motion.div>

      {/* ========== System Health (full width) ========== */}
      <motion.div variants={itemVariants}>
        <SystemHealth />
      </motion.div>

      {/* ========== Recent Activity (full width) ========== */}
      <motion.div variants={itemVariants}>
        <ActivityFeed />
      </motion.div>
    </motion.div>
  )
}
