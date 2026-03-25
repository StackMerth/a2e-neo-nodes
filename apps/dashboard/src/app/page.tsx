'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Card, StatCard } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { api } from '@/lib/api'
import { ActivityFeed } from '@/components/dashboard/ActivityFeed'
import { SystemHealth } from '@/components/dashboard/SystemHealth'
import { EarningsChart } from '@/components/dashboard/EarningsChart'

interface Stats {
  nodes: { total: number; byStatus: Record<string, number> }
  jobs: { total: number; last24h: number; byMarket: Record<string, number> }
  routing: { decisionsLast24h: number; avgDecisionTimeMs: number }
  earnings: { last24h: { total: number } }
}

export default function OverviewPage() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadStats()
    const interval = setInterval(loadStats, 10000)
    return () => clearInterval(interval)
  }, [])

  async function loadStats() {
    try {
      const data = await api.stats.overview()
      setStats(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load stats')
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-text-muted">Loading...</div>
      </div>
    )
  }

  if (error) {
    return (
      <Card className="border-error">
        <p className="text-error">Error: {error}</p>
        <Button onClick={loadStats} variant="outline" className="mt-4">
          Retry
        </Button>
      </Card>
    )
  }

  return (
    <div className="space-y-8">
      {/* Hero Section */}
      <div className="text-center py-8">
        <div className="inline-flex items-center gap-2 px-3 py-1 bg-accent/10 border border-accent/20 rounded-full mb-4">
          <span className="w-2 h-2 bg-accent rounded-full animate-pulse" />
          <span className="text-xs text-accent font-medium uppercase tracking-wider">Live Dashboard</span>
        </div>
        <h1 className="text-3xl md:text-4xl font-bold text-text-primary">
          A²E Engine Overview
        </h1>
        <p className="text-text-muted mt-2 max-w-xl mx-auto">
          Real-time monitoring for the Arbitrage & Orchestration Engine
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Active Nodes"
          value={stats?.nodes.total ?? 0}
        />
        <StatCard
          label="Routing Decisions"
          value={stats?.routing.decisionsLast24h ?? 0}
          suffix="/24h"
        />
        <StatCard
          label="Avg Decision Time"
          value={stats?.routing.avgDecisionTimeMs?.toFixed(1) ?? '0'}
          suffix="ms"
        />
        <StatCard
          label="Earnings (24h)"
          value={(stats?.earnings.last24h.total ?? 0).toFixed(2)}
          prefix="$"
        />
      </div>

      {/* Distribution Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card title="Jobs by Market">
          <div className="space-y-4 mt-4">
            {Object.entries(stats?.jobs.byMarket ?? {}).length > 0 ? (
              Object.entries(stats?.jobs.byMarket ?? {}).map(([market, count]) => {
                const total = Object.values(stats?.jobs.byMarket ?? {}).reduce((a, b) => a + b, 0)
                const percentage = total > 0 ? (count / total) * 100 : 0
                return (
                  <div key={market}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm text-text-primary">{market}</span>
                      <span className="text-sm text-text-muted">{count} jobs</span>
                    </div>
                    <div className="h-2 bg-background rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          market === 'INTERNAL' ? 'bg-accent' : market === 'AKASH' ? 'bg-blue-500' : 'bg-purple-500'
                        }`}
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                  </div>
                )
              })
            ) : (
              <p className="text-text-muted text-sm">No jobs routed yet. <Link href="/routing" className="text-accent hover:underline">Test routing</Link></p>
            )}
          </div>
        </Card>

        <Card title="Node Status">
          <div className="space-y-4 mt-4">
            {['ONLINE', 'DEGRADED', 'OFFLINE'].map((status) => {
              const count = stats?.nodes.byStatus?.[status] ?? 0
              const total = stats?.nodes.total ?? 0
              const percentage = total > 0 ? (count / total) * 100 : 0
              return (
                <div key={status}>
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${
                        status === 'ONLINE' ? 'bg-accent' : status === 'DEGRADED' ? 'bg-warning' : 'bg-error'
                      }`} />
                      <span className="text-sm text-text-primary">{status}</span>
                    </div>
                    <span className="text-sm text-text-muted">{count}</span>
                  </div>
                  <div className="h-2 bg-background rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${
                        status === 'ONLINE' ? 'bg-accent' : status === 'DEGRADED' ? 'bg-warning' : 'bg-error'
                      }`}
                      style={{ width: `${percentage}%` }}
                    />
                  </div>
                </div>
              )
            })}
            {stats?.nodes.total === 0 && (
              <p className="text-text-muted text-sm">No nodes registered. <Link href="/nodes" className="text-accent hover:underline">Add a node</Link></p>
            )}
          </div>
        </Card>
      </div>

      {/* Earnings Chart */}
      <EarningsChart />

      {/* System Status Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* System Health */}
        <div className="lg:col-span-1">
          <SystemHealth />
        </div>

        {/* Activity Feed */}
        <div className="lg:col-span-2">
          <ActivityFeed />
        </div>
      </div>

      {/* Quick Actions */}
      <div className="flex flex-wrap gap-4 justify-center pt-8">
        <Link href="/routing">
          <Button variant="primary" size="lg">Test Routing</Button>
        </Link>
        <Link href="/nodes">
          <Button variant="outline" size="lg">Manage Nodes</Button>
        </Link>
        <Link href="/rates">
          <Button variant="secondary" size="lg">View Rates</Button>
        </Link>
      </div>
    </div>
  )
}
