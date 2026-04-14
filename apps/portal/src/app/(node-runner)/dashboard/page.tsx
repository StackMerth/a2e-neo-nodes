'use client'

import { useState, useEffect, useCallback } from 'react'
import { nodeRunner } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { useWebSocket } from '@/hooks/useWebSocket'

interface DashboardData {
  earnings: { today: number; week: number; month: number; allTime: number }
  nodes: { total: number; online: number; offline: number; maintenance: number }
  jobs: { completed: number; running: number }
  totalPaidOut: number
  uptimePercent: number
}

type Period = 'today' | 'week' | 'month' | 'allTime'

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<Period>('month')

  useEffect(() => {
    loadData()
    const interval = setInterval(loadData, 15000)
    return () => clearInterval(interval)
  }, [])

  async function loadData() {
    try {
      const d = await nodeRunner.dashboard() as DashboardData
      setData(d)
    } catch {
      /* ignore */
    } finally {
      setLoading(false)
    }
  }

  // Real-time updates via WebSocket
  const handleNodeEvent = useCallback(() => { loadData() }, [])
  useWebSocket({
    events: {
      'node:statusChange': handleNodeEvent,
      'node:offline': handleNodeEvent,
      'node:registered': handleNodeEvent,
      'job:completed': handleNodeEvent,
      'job:failed': handleNodeEvent,
    },
  })

  if (loading) {
    return (
      <div className="space-y-6 animate-fadeIn">
        <Skeleton className="h-32 w-full" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  const earningsValue = data?.earnings[period] ?? 0

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* Hero */}
      <div className="relative py-6">
        <div className="absolute inset-0 bg-gradient-to-b from-accent/5 via-transparent to-transparent rounded-2xl" />
        <div className="relative">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-accent/5 border border-accent/20 rounded-full mb-4">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-accent" />
            </span>
            <span className="text-xs text-accent font-medium uppercase tracking-wider">Live</span>
          </div>
          <h1 className="text-2xl md:text-3xl font-bold text-text-primary">Node Runner Dashboard</h1>
          <p className="text-text-muted mt-1">Monitor your nodes, earnings, and performance in real-time.</p>
        </div>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Total Earnings"
          value={`$${(data?.earnings.allTime ?? 0).toFixed(2)}`}
          color="accent"
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        />
        <StatCard
          label="Active Nodes"
          value={`${data?.nodes.online ?? 0}/${data?.nodes.total ?? 0}`}
          color="blue"
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />
            </svg>
          }
        />
        <StatCard
          label="Uptime"
          value={`${data?.uptimePercent ?? 0}%`}
          color="purple"
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          }
        />
        <StatCard
          label="Jobs Completed"
          value={`${data?.jobs.completed ?? 0}`}
          color="orange"
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          }
        />
      </div>

      {/* Earnings Period Selector */}
      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-text-primary">Earnings</h2>
          <div className="flex gap-1 bg-surface-hover rounded-lg p-1">
            {(['today', 'week', 'month', 'allTime'] as Period[]).map(p => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                  period === p
                    ? 'bg-accent text-white'
                    : 'text-text-muted hover:text-text-secondary'
                }`}
              >
                {p === 'allTime' ? 'All Time' : p.charAt(0).toUpperCase() + p.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div className="text-4xl font-bold text-text-primary">${earningsValue.toFixed(2)}</div>
        <p className="text-sm text-text-muted mt-1">
          {period === 'today'
            ? 'Earned today'
            : period === 'week'
            ? 'Last 7 days'
            : period === 'month'
            ? 'Last 30 days'
            : 'Lifetime earnings'}
        </p>
      </Card>

      {/* Node Status + Quick Actions */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="p-6">
          <h2 className="text-lg font-semibold text-text-primary mb-4">Node Status</h2>
          <div className="space-y-3">
            <NodeStatusRow label="Online" count={data?.nodes.online ?? 0} color="accent" />
            <NodeStatusRow label="Offline" count={data?.nodes.offline ?? 0} color="error" />
            <NodeStatusRow label="Maintenance" count={data?.nodes.maintenance ?? 0} color="warning" />
          </div>
        </Card>

        <Card className="p-6">
          <h2 className="text-lg font-semibold text-text-primary mb-4">Quick Actions</h2>
          <div className="space-y-3">
            <Button variant="secondary" className="w-full justify-start gap-3">
              <svg className="w-4 h-4 text-warning" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Pause All Nodes
            </Button>
            <Button variant="secondary" className="w-full justify-start gap-3">
              <svg className="w-4 h-4 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Resume All Nodes
            </Button>
            <Button variant="secondary" className="w-full justify-start gap-3">
              <svg className="w-4 h-4 text-info" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
              </svg>
              Add New Node
            </Button>
          </div>
        </Card>
      </div>

      {/* Total Paid Out */}
      <Card className="p-6 bg-gradient-to-r from-accent/5 via-surface to-surface border-accent/20">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-text-muted">Total Paid Out</p>
            <p className="text-2xl font-bold text-accent">${(data?.totalPaidOut ?? 0).toFixed(2)}</p>
          </div>
          <div className="text-sm text-text-muted">
            {data?.jobs.running ?? 0} jobs currently running
          </div>
        </div>
      </Card>
    </div>
  )
}

function StatCard({
  label,
  value,
  color,
  icon,
}: {
  label: string
  value: string
  color: 'accent' | 'blue' | 'purple' | 'orange'
  icon: React.ReactNode
}) {
  const colors = {
    accent: 'from-accent/10 to-transparent border-accent/20 text-accent',
    blue: 'from-accent-blue/10 to-transparent border-accent-blue/20 text-accent-blue',
    purple: 'from-accent-purple/10 to-transparent border-accent-purple/20 text-accent-purple',
    orange: 'from-accent-orange/10 to-transparent border-accent-orange/20 text-accent-orange',
  }

  return (
    <div className={`bg-gradient-to-br ${colors[color]} border rounded-xl p-5 transition-all hover:shadow-card`}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-text-muted uppercase tracking-wider">{label}</span>
        <span className="opacity-60">{icon}</span>
      </div>
      <p className="text-2xl font-bold text-text-primary">{value}</p>
    </div>
  )
}

function NodeStatusRow({
  label,
  count,
  color,
}: {
  label: string
  count: number
  color: 'accent' | 'error' | 'warning'
}) {
  const dotColors = {
    accent: 'bg-accent shadow-[0_0_8px_theme(colors.accent)]',
    error: 'bg-error shadow-[0_0_8px_theme(colors.error)]',
    warning: 'bg-warning shadow-[0_0_8px_theme(colors.warning)]',
  }

  return (
    <div className="flex items-center justify-between py-2">
      <div className="flex items-center gap-3">
        <span className={`w-2.5 h-2.5 rounded-full ${dotColors[color]}`} />
        <span className="text-sm text-text-secondary">{label}</span>
      </div>
      <span className="text-sm font-semibold text-text-primary">{count}</span>
    </div>
  )
}
