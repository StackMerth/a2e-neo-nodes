'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip,
} from 'recharts'
import {
  Server,
  GitBranch,
  Clock,
  DollarSign,
  AlertTriangle,
} from 'lucide-react'
import { api } from '@/lib/api'
import { SystemHealth } from '@/components/dashboard/SystemHealth'
import { ActivityFeed } from '@/components/dashboard/ActivityFeed'
import { A2ELoader } from '@/components/ui/A2ELoader'
import {
  DashboardShell,
  DashboardMainColumn,
  DashboardRightRail,
  SectionCard,
  MetricTriad,
  ClockCard,
} from '@/components/dashboard/FuturisticShell'

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
    <div className="rounded-md border border-border px-3 py-2" style={{ background: 'var(--bg-card)' }}>
      <p className="font-mono text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>{payload[0].name}</p>
      <p className="font-mono text-sm" style={{ color: 'var(--text-primary)' }}>{payload[0].value}</p>
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

  /* -- Loading state -- */

  if (loading) {
    return <A2ELoader fullScreen={false} message="Loading engine overview" />
  }

  /* -- Error state -- */

  if (error && !stats) {
    return (
      <DashboardShell title="TokenOS DeAI Engine Overview" subtitle="Network operations" onRefresh={() => loadStats(true)} refreshing={refreshing}>
        <div className="lg:col-span-3">
          <SectionCard>
            <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
              <div
                className="w-14 h-14 rounded-full inline-flex items-center justify-center mb-4"
                style={{ background: 'rgba(239, 68, 68, 0.12)' }}
              >
                <AlertTriangle size={28} style={{ color: '#ef4444' }} />
              </div>
              <h2 className="font-display text-lg mb-1" style={{ color: 'var(--text-primary)' }}>
                Connection Error
              </h2>
              <p className="text-sm max-w-sm mb-5" style={{ color: 'var(--text-muted)' }}>
                {error}
              </p>
              <button className="btn btn-primary" onClick={() => loadStats()}>
                Try Again
              </button>
            </div>
          </SectionCard>
        </div>
      </DashboardShell>
    )
  }

  /* -- Render -- */

  return (
    <DashboardShell
      title="TokenOS DeAI Engine Overview"
      subtitle="Network operations"
      liveLabel="LIVE"
      onRefresh={() => loadStats(true)}
      refreshing={refreshing}
    >
      <DashboardMainColumn>
        <MetricTriad
          metrics={[
            {
              label: 'Active Nodes',
              value: String(stats?.nodes.total ?? 0),
              icon: Server,
              tone: 'green',
            },
            {
              label: 'Routing Decisions 24h',
              value: String(stats?.routing.decisionsLast24h ?? 0),
              detail: `Avg ${(stats?.routing.avgDecisionTimeMs ?? 0).toFixed(1)}ms`,
              icon: GitBranch,
              tone: 'blue',
            },
            {
              label: 'Earnings 24h',
              value: `$${(stats?.earnings.last24h.total ?? 0).toFixed(2)}`,
              detail: `${stats?.earnings.last24h.jobCount ?? 0} jobs`,
              icon: DollarSign,
              tone: 'orange',
            },
          ]}
        />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <SectionCard title="Jobs by Market" icon={GitBranch}>
            {jobsByMarket.length > 0 ? (
              <div className="flex items-center gap-4">
                <div className="h-48 w-48 relative shrink-0">
                  <ResponsiveContainer width="100%" height="100%">
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
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                    <span className="font-display text-2xl" style={{ color: 'var(--text-primary)' }}>{totalJobs}</span>
                    <span className="font-mono text-[10px] tracking-[0.14em] uppercase" style={{ color: 'var(--text-muted)' }}>Total</span>
                  </div>
                </div>
                <div className="flex-1 min-w-0 space-y-1.5">
                  {jobsByMarket.map((item, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm">
                      <span className="w-2 h-2 rounded-sm" style={{ background: item.color }} />
                      <span className="flex-1 font-mono text-[11px] truncate" style={{ color: 'var(--text-secondary)' }}>{item.name}</span>
                      <span className="font-mono text-sm" style={{ color: 'var(--text-primary)' }}>{item.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-sm py-8 text-center" style={{ color: 'var(--text-muted)' }}>No jobs routed yet</p>
            )}
          </SectionCard>

          <SectionCard title="Node Status" icon={Server}>
            {nodeStatusData.length > 0 ? (
              <div className="flex items-center gap-4">
                <div className="h-48 w-48 relative shrink-0">
                  <ResponsiveContainer width="100%" height="100%">
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
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                    <span className="font-display text-2xl" style={{ color: 'var(--text-primary)' }}>{stats?.nodes.total ?? 0}</span>
                    <span className="font-mono text-[10px] tracking-[0.14em] uppercase" style={{ color: 'var(--text-muted)' }}>Nodes</span>
                  </div>
                </div>
                <div className="flex-1 min-w-0 space-y-1.5">
                  {nodeStatusData.map((item, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm">
                      <span className="w-2 h-2 rounded-sm" style={{ background: item.color }} />
                      <span className="flex-1 font-mono text-[11px] truncate" style={{ color: 'var(--text-secondary)' }}>{item.name}</span>
                      <span className="font-mono text-sm" style={{ color: 'var(--text-primary)' }}>{item.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-sm py-8 text-center" style={{ color: 'var(--text-muted)' }}>No nodes registered</p>
            )}
          </SectionCard>
        </div>

        <SectionCard title="System Health" icon={Clock} noPadding>
          <div className="p-5 sm:p-6">
            <SystemHealth />
          </div>
        </SectionCard>

        <SectionCard title="Recent Activity" icon={Clock} noPadding>
          <div className="p-5 sm:p-6">
            <ActivityFeed />
          </div>
        </SectionCard>
      </DashboardMainColumn>

      <DashboardRightRail>
        <ClockCard />
      </DashboardRightRail>
    </DashboardShell>
  )
}
