'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Card, StatCard, MetricCard } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { ProgressBar, DistributionBar } from '@/components/ui/ProgressBar'
import { SkeletonOverview } from '@/components/ui/Skeleton'
import { api } from '@/lib/api'
import { ActivityFeed } from '@/components/dashboard/ActivityFeed'
import { SystemHealth } from '@/components/dashboard/SystemHealth'
import { EarningsChart } from '@/components/dashboard/EarningsChart'

interface Stats {
  nodes: { total: number; byStatus: Record<string, number>; byTier: Record<string, number> }
  jobs: { total: number; last24h: number; byMarket: Record<string, number>; byStatus: Record<string, number> }
  routing: { decisionsLast24h: number; avgDecisionTimeMs: number; byMarket: Record<string, number> }
  earnings: { last24h: { total: number; gpuSeconds: number; jobCount: number } }
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
    return <SkeletonOverview />
  }

  if (error) {
    return (
      <div className="max-w-md mx-auto mt-20">
        <Card variant="elevated" className="text-center">
          <div className="w-16 h-16 rounded-full bg-error/10 flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-error" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-text-primary mb-2">Connection Error</h2>
          <p className="text-text-muted text-sm mb-6">{error}</p>
          <Button onClick={loadStats} variant="gradient">
            Try Again
          </Button>
        </Card>
      </div>
    )
  }

  const totalJobs = stats?.jobs.total ?? 0
  const marketDistribution = Object.entries(stats?.jobs.byMarket ?? {}).map(([market, count]) => ({
    label: market,
    value: count,
    color: market === 'INTERNAL' ? 'accent' as const : market === 'AKASH' ? 'blue' as const : 'purple' as const,
  }))

  const nodeStatusDistribution = [
    { label: 'Online', value: stats?.nodes.byStatus?.ONLINE ?? 0, color: 'accent' as const, progressColor: 'accent' as const },
    { label: 'Degraded', value: stats?.nodes.byStatus?.DEGRADED ?? 0, color: 'orange' as const, progressColor: 'orange' as const },
    { label: 'Offline', value: stats?.nodes.byStatus?.OFFLINE ?? 0, color: 'gray' as const, progressColor: 'accent' as const },
  ]

  return (
    <div className="space-y-8 animate-fadeIn">
      {/* Hero Section */}
      <div className="relative py-8 md:py-12">
        {/* Background gradient */}
        <div className="absolute inset-0 bg-gradient-to-b from-accent/5 via-transparent to-transparent rounded-3xl" />

        <div className="relative text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-accent/5 border border-accent/20 rounded-full mb-6 animate-slideUp">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-accent" />
            </span>
            <span className="text-xs text-accent font-medium uppercase tracking-wider">Live Dashboard</span>
          </div>

          <h1 className="text-3xl md:text-5xl font-bold text-text-primary mb-3">
            A<sup className="text-accent">2</sup>E Engine Overview
          </h1>
          <p className="text-text-muted max-w-xl mx-auto">
            Real-time monitoring for the Arbitrage & Orchestration Engine.
            Track node health, routing decisions, and earnings across all markets.
          </p>
        </div>
      </div>

      {/* Primary Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Active Nodes"
          value={stats?.nodes.total ?? 0}
          variant="accent"
          animate
          icon={<ServerIcon />}
          trend={stats?.nodes.total ? { value: 5.2, isPositive: true } : undefined}
        />
        <StatCard
          label="Routing Decisions"
          value={stats?.routing.decisionsLast24h ?? 0}
          suffix="/24h"
          variant="blue"
          animate
          icon={<RouteIcon />}
        />
        <StatCard
          label="Avg Decision Time"
          value={stats?.routing.avgDecisionTimeMs?.toFixed(1) ?? '0'}
          suffix="ms"
          variant="purple"
          animate
          icon={<ClockIcon />}
        />
        <StatCard
          label="Earnings (24h)"
          value={(stats?.earnings.last24h.total ?? 0).toFixed(2)}
          prefix="$"
          variant="orange"
          animate
          icon={<DollarIcon />}
          trend={stats?.earnings.last24h.total ? { value: 12.5, isPositive: true } : undefined}
        />
      </div>

      {/* Distribution Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Jobs by Market */}
        <Card variant="glass" title="Jobs by Market" description="Distribution across markets">
          {totalJobs > 0 ? (
            <div className="space-y-6 mt-4">
              <DistributionBar segments={marketDistribution} size="lg" showLegend />
              <div className="grid grid-cols-3 gap-3">
                {marketDistribution.map(({ label, value, color }) => (
                  <div
                    key={label}
                    className={`
                      p-3 rounded-lg border transition-all duration-300
                      ${color === 'accent' ? 'bg-accent/5 border-accent/20 hover:border-accent/40' :
                        color === 'blue' ? 'bg-accent-blue/5 border-accent-blue/20 hover:border-accent-blue/40' :
                        'bg-accent-purple/5 border-accent-purple/20 hover:border-accent-purple/40'}
                    `}
                  >
                    <p className="text-xs text-text-muted mb-1">{label}</p>
                    <p className={`text-lg font-bold ${
                      color === 'accent' ? 'text-accent' :
                      color === 'blue' ? 'text-accent-blue' :
                      'text-accent-purple'
                    }`}>
                      {value}
                    </p>
                    <p className="text-xs text-text-muted">
                      {totalJobs > 0 ? ((value / totalJobs) * 100).toFixed(1) : 0}%
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <EmptyState
              icon={<BriefcaseIcon className="w-8 h-8" />}
              title="No jobs routed yet"
              description="Jobs will appear here once routing begins"
              action={
                <Link href="/routing">
                  <Button variant="outline" size="sm">Test Routing</Button>
                </Link>
              }
            />
          )}
        </Card>

        {/* Node Status */}
        <Card variant="glass" title="Node Status" description="Health overview of registered nodes">
          {(stats?.nodes.total ?? 0) > 0 ? (
            <div className="space-y-6 mt-4">
              <DistributionBar segments={nodeStatusDistribution} size="lg" showLegend />
              <div className="space-y-3">
                {nodeStatusDistribution.map(({ label, value, color, progressColor }) => {
                  const dotColor = color === 'accent' ? 'bg-accent shadow-[0_0_8px_rgba(34,197,94,0.5)]'
                    : color === 'orange' ? 'bg-warning shadow-[0_0_8px_rgba(245,158,11,0.5)]'
                    : 'bg-error shadow-[0_0_8px_rgba(239,68,68,0.5)]'

                  return (
                    <div
                      key={label}
                      className="flex items-center justify-between p-3 bg-surface/50 rounded-lg border border-border/50 hover:border-border transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <span className={`w-3 h-3 rounded-full ${dotColor}`} />
                        <span className="text-sm font-medium text-text-primary">{label}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <ProgressBar
                          value={(stats?.nodes.total ?? 0) > 0 ? (value / (stats?.nodes.total ?? 1)) * 100 : 0}
                          variant={progressColor}
                          size="sm"
                          className="w-24"
                        />
                        <span className="text-sm font-bold text-text-primary w-8 text-right">{value}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ) : (
            <EmptyState
              icon={<ServerIcon className="w-8 h-8" />}
              title="No nodes registered"
              description="Register your first GPU node to get started"
              action={
                <Link href="/nodes">
                  <Button variant="outline" size="sm">Add Node</Button>
                </Link>
              }
            />
          )}
        </Card>
      </div>

      {/* Earnings Chart */}
      <EarningsChart />

      {/* System Status Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1">
          <SystemHealth />
        </div>
        <div className="lg:col-span-2">
          <ActivityFeed />
        </div>
      </div>

      {/* Quick Actions */}
      <div className="relative py-8">
        <div className="absolute inset-0 bg-gradient-to-t from-accent/5 via-transparent to-transparent rounded-3xl" />
        <div className="relative flex flex-wrap gap-4 justify-center">
          <Link href="/routing">
            <Button variant="gradient" size="lg" icon={<RouteIcon />}>
              Test Routing
            </Button>
          </Link>
          <Link href="/nodes">
            <Button variant="gradient-outline" size="lg" icon={<ServerIcon />}>
              Manage Nodes
            </Button>
          </Link>
          <Link href="/rates">
            <Button variant="secondary" size="lg" icon={<ChartIcon />}>
              View Rates
            </Button>
          </Link>
        </div>
      </div>
    </div>
  )
}

// Empty State Component
function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode
  title: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <div className="py-8 text-center">
      <div className="w-16 h-16 rounded-2xl bg-surface-hover flex items-center justify-center mx-auto mb-4 text-text-muted">
        {icon}
      </div>
      <h3 className="text-sm font-medium text-text-primary mb-1">{title}</h3>
      <p className="text-xs text-text-muted mb-4">{description}</p>
      {action}
    </div>
  )
}

// Icons
function ServerIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />
    </svg>
  )
}

function RouteIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
    </svg>
  )
}

function ClockIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function DollarIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function ChartIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
    </svg>
  )
}

function BriefcaseIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  )
}
