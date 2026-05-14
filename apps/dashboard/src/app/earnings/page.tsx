'use client'

import { useEffect, useState, useCallback } from 'react'
import { DollarSign, BarChart3, TrendingUp, Clock, Briefcase, Server, List, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { DistributionBar } from '@/components/ui/ProgressBar'
import { api } from '@/lib/api'
import {
  DashboardShell,
  DashboardMainColumn,
  DashboardRightRail,
  SectionCard,
  MetricTriad,
} from '@/components/dashboard/FuturisticShell'

interface EarningsSummary {
  totalEarnings: number
  totalGpuSeconds: number
  totalJobs: number
  byMarket: Record<string, { earnings: number; jobs: number }>
  byNode: Record<string, { earnings: number; jobs: number }>
}

interface MarketEarnings {
  period: { start: string; end: string }
  total: { earnings: number; gpuHours: number; jobCount: number }
  byMarket: Record<string, { earnings: number; gpuHours: number; jobCount: number }>
}

interface TierEarnings {
  period: { start: string; end: string }
  byTier: Record<string, { earnings: number; gpuHours: number; jobCount: number }>
}

interface TrendData {
  date: string
  earnings: number
  gpuHours: number
  jobCount: number
}

interface TrendResponse {
  period: { start: string; end: string; days: number; groupBy: string }
  trend: TrendData[]
}

interface EarningRecord {
  id: string
  nodeId: string
  walletAddress: string
  gpuTier: string
  date: string
  market: string
  earnings: number
  gpuSeconds: number
  jobCount: number
}

type Tab = 'overview' | 'records' | 'by-tier'

const GPU_TIERS = ['H100', 'H200', 'B200', 'B300', 'GB300']

export default function EarningsPage() {
  const [activeTab, setActiveTab] = useState<Tab>('overview')
  const [summary, setSummary] = useState<EarningsSummary | null>(null)
  const [byMarket, setByMarket] = useState<MarketEarnings | null>(null)
  const [byTier, setByTier] = useState<TierEarnings | null>(null)
  const [trends, setTrends] = useState<TrendResponse | null>(null)
  const [records, setRecords] = useState<EarningRecord[]>([])
  const [recordsTotal, setRecordsTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [days, setDays] = useState(7)

  // Filters for records tab
  const [marketFilter, setMarketFilter] = useState<string>('')
  const [page, setPage] = useState(1)
  const limit = 20

  const loadEarnings = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    try {
      const [summaryData, marketData, tierData, trendData] = await Promise.all([
        api.earnings.summary().catch(() => null),
        api.earnings.byMarket({ days }).catch(() => null),
        api.earnings.byTier({ days }).catch(() => null),
        api.earnings.trends({ days, groupBy: 'day' }).catch(() => null),
      ])
      setSummary(summaryData)
      setByMarket(marketData)
      setByTier(tierData)
      setTrends(trendData)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load earnings')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [days])

  const loadRecords = useCallback(async () => {
    try {
      const data = await api.earnings.list({
        market: marketFilter || undefined,
        limit,
        offset: (page - 1) * limit,
      })
      setRecords(data.earnings)
      setRecordsTotal(data.total)
    } catch (err) {
      console.error('Failed to load records:', err)
    }
  }, [marketFilter, page])

  useEffect(() => {
    loadEarnings()
  }, [loadEarnings])

  useEffect(() => {
    if (activeTab === 'records') {
      loadRecords()
    }
  }, [activeTab, loadRecords])

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
    }).format(value)
  }

  const formatHours = (seconds: number) => {
    const hours = seconds / 3600
    return hours.toFixed(1) + 'h'
  }

  const getMarketColor = (market: string): 'accent' | 'blue' | 'purple' | 'amber' | 'orange' | 'gray' => {
    switch (market) {
      case 'INTERNAL': return 'accent'
      case 'AKASH': return 'blue'
      case 'IONET': return 'purple'
      case 'VASTAI': return 'amber'
      default: return 'gray'
    }
  }

  const getMarketBadgeStyle = (market: string) => {
    switch (market) {
      case 'INTERNAL': return 'bg-accent/10 text-accent border-accent/20'
      case 'AKASH': return 'bg-blue-500/10 text-blue-400 border-blue-500/20'
      case 'IONET': return 'bg-purple-500/10 text-purple-400 border-purple-500/20'
      case 'VASTAI': return 'bg-amber-500/10 text-amber-400 border-amber-500/20'
      default: return 'bg-text-muted/10 text-text-muted border-border'
    }
  }

  const getTierColor = (tier: string) => {
    switch (tier) {
      case 'H100': return 'bg-green-500'
      case 'H200': return 'bg-blue-500'
      case 'B200': return 'bg-purple-500'
      case 'B300': return 'bg-orange-500'
      case 'GB300': return 'bg-red-500'
      default: return 'bg-gray-500'
    }
  }

  const totalPages = Math.ceil(recordsTotal / limit)

  // Build distribution segments for market breakdown
  const marketDistribution = byMarket?.byMarket
    ? Object.entries(byMarket.byMarket).map(([market, data]) => ({
        label: market,
        value: data.earnings,
        color: getMarketColor(market),
      }))
    : []

  return (
    <DashboardShell
      title="Earnings"
      subtitle="Network-wide revenue"
      liveLabel="LIVE"
      onRefresh={() => loadEarnings(true)}
      refreshing={refreshing}
    >
      <DashboardMainColumn>
        <MetricTriad
          metrics={[
            {
              label: 'Total Earnings',
              value: formatCurrency(summary?.totalEarnings ?? 0),
              icon: DollarSign,
              tone: 'green',
            },
            {
              label: `Last ${days}d`,
              value: formatCurrency(byMarket?.total.earnings ?? 0),
              detail: `${byMarket?.total.jobCount ?? 0} jobs`,
              icon: TrendingUp,
              tone: 'blue',
            },
            {
              label: 'GPU Time',
              value: formatHours(summary?.totalGpuSeconds ?? 0),
              detail: `${(summary?.totalJobs ?? 0).toLocaleString()} jobs`,
              icon: Clock,
              tone: 'purple',
            },
          ]}
        />

        {/* Tab strip + period selector */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex gap-1 p-1 bg-surface rounded-xl">
            {[
              { id: 'overview', label: 'Overview' },
              { id: 'records', label: 'Records' },
              { id: 'by-tier', label: 'By Tier' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as Tab)}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-all ${
                  activeTab === tab.id
                    ? 'bg-accent text-white shadow-lg shadow-accent/20'
                    : 'hover:bg-surface-hover'
                }`}
                style={activeTab === tab.id ? undefined : { color: 'var(--text-secondary)' }}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="px-4 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent"
            style={{ color: 'var(--text-primary)' }}
          >
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </div>

        {error && (
          <div className="p-4 bg-error/10 border border-error/20 rounded-xl flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-error/20 flex items-center justify-center shrink-0">
              <AlertTriangle className="w-4 h-4 text-error" />
            </div>
            <p className="text-error text-sm">{error}</p>
          </div>
        )}

        {loading && activeTab !== 'records' ? null : (
          <>
            {activeTab === 'overview' && (
              <>
                {byMarket && byMarket.total.earnings > 0 && (
                  <SectionCard title="Revenue by Market" icon={BarChart3} badge={<span className="text-lg font-bold text-accent ml-2">{formatCurrency(byMarket.total.earnings)}</span>}>
                    <DistributionBar segments={marketDistribution} size="lg" showLegend />
                  </SectionCard>
                )}

                <SectionCard title="Markets Breakdown" icon={BarChart3}>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                    {byMarket?.byMarket && Object.entries(byMarket.byMarket).map(([market, data]) => {
                      const percentage = byMarket.total.earnings > 0
                        ? (data.earnings / byMarket.total.earnings) * 100
                        : 0
                      const iconBg =
                        market === 'INTERNAL' ? 'bg-accent/20' :
                        market === 'AKASH' ? 'bg-blue-500/20' :
                        market === 'IONET' ? 'bg-purple-500/20' : ''
                      const iconStyle = market === 'VASTAI' ? { background: 'rgba(234,179,8,0.18)' } : undefined
                      const textCls =
                        market === 'INTERNAL' ? 'text-accent' :
                        market === 'AKASH' ? 'text-blue-400' :
                        market === 'IONET' ? 'text-purple-400' : ''
                      const textStyle = market === 'VASTAI' ? { color: '#eab308' } : undefined
                      const barCls =
                        market === 'INTERNAL' ? 'bg-accent' :
                        market === 'AKASH' ? 'bg-blue-500' :
                        market === 'IONET' ? 'bg-purple-500' : ''
                      const barStyle = market === 'VASTAI' ? { background: '#eab308', width: `${percentage}%` } : { width: `${percentage}%` }
                      return (
                        <div key={market} className="p-4 rounded-md border border-border" style={{ background: 'var(--bg-elevated)' }}>
                          <div className="flex items-center gap-3 mb-4">
                            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${iconBg}`} style={iconStyle}>
                              <span className={`text-lg font-bold ${textCls}`} style={textStyle}>
                                {market.charAt(0)}
                              </span>
                            </div>
                            <span className={`font-semibold ${textCls}`} style={textStyle}>
                              {market === 'VASTAI' ? 'VAST.AI' : market}
                            </span>
                          </div>
                          <p className="text-3xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>
                            {formatCurrency(data.earnings)}
                          </p>
                          <div className="flex items-center justify-between text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
                            <span>{data.jobCount} jobs</span>
                            <span>{data.gpuHours.toFixed(1)}h GPU time</span>
                          </div>
                          <div className="h-2 bg-surface-hover rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${barCls}`} style={barStyle} />
                          </div>
                          <p className="text-xs mt-2 text-right" style={{ color: 'var(--text-muted)' }}>
                            {percentage.toFixed(1)}% of total
                          </p>
                        </div>
                      )
                    })}
                    {(!byMarket?.byMarket || Object.keys(byMarket.byMarket).length === 0) && (
                      <div className="col-span-3 py-8 text-center">
                        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No earnings data</p>
                      </div>
                    )}
                  </div>
                </SectionCard>

                <SectionCard title="Earnings Trend" icon={BarChart3}>
                  {trends?.trend && trends.trend.length > 0 ? (
                    <div>
                      <div className="h-48 flex items-end gap-1 px-2">
                        {(() => {
                          const maxEarnings = Math.max(...trends.trend.map(t => t.earnings))
                          return trends.trend.map((t, i) => {
                            const height = maxEarnings > 0 ? (t.earnings / maxEarnings) * 100 : 0
                            const isToday = i === trends.trend.length - 1
                            return (
                              <div key={i} className="flex-1 min-w-0 group relative">
                                <div
                                  className={`w-full rounded-t transition-all ${
                                    isToday ? 'bg-accent' : 'bg-accent/50'
                                  } hover:bg-accent`}
                                  style={{ height: `${height}%`, minHeight: t.earnings > 0 ? '4px' : '0px' }}
                                />
                                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 bg-surface border border-border rounded-lg text-xs whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-10 pointer-events-none shadow-xl">
                                  <p className="font-semibold" style={{ color: 'var(--text-primary)' }}>{formatCurrency(t.earnings)}</p>
                                  <p style={{ color: 'var(--text-muted)' }}>{t.jobCount} jobs</p>
                                  <p style={{ color: 'var(--text-muted)' }}>{new Date(t.date).toLocaleDateString()}</p>
                                </div>
                              </div>
                            )
                          })
                        })()}
                      </div>
                      <div className="flex justify-between px-2 mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                        <span>{new Date(trends.trend[0]?.date).toLocaleDateString()}</span>
                        <span>{new Date(trends.trend[trends.trend.length - 1]?.date).toLocaleDateString()}</span>
                      </div>
                      <div className="flex items-center justify-between text-sm border-t border-border pt-4 mt-4">
                        <div>
                          <span style={{ color: 'var(--text-muted)' }}>Total:</span>{' '}
                          <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{formatCurrency(trends.trend.reduce((s, t) => s + t.earnings, 0))}</span>
                        </div>
                        <div>
                          <span className="text-accent">Best Day:</span>{' '}
                          <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{formatCurrency(Math.max(...trends.trend.map(t => t.earnings)))}</span>
                        </div>
                        <div>
                          <span style={{ color: 'var(--text-muted)' }}>Avg/Day:</span>{' '}
                          <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{formatCurrency(trends.trend.reduce((s, t) => s + t.earnings, 0) / trends.trend.length)}</span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm py-8 text-center" style={{ color: 'var(--text-muted)' }}>No trend data</p>
                  )}
                </SectionCard>

                {summary?.byNode && Object.keys(summary.byNode).length > 0 && (
                  <SectionCard title="Top Earning Nodes" icon={Server}>
                    <div className="overflow-x-auto">
                      <table className="w-full">
                        <thead>
                          <tr className="border-b border-border">
                            <th className="text-left py-3 px-4 text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Node ID</th>
                            <th className="text-right py-3 px-4 text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Jobs</th>
                            <th className="text-right py-3 px-4 text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Earnings</th>
                            <th className="text-right py-3 px-4 text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Share</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(summary.byNode)
                            .sort((a, b) => b[1].earnings - a[1].earnings)
                            .slice(0, 10)
                            .map(([nodeId, data]) => {
                              const share = summary.totalEarnings > 0
                                ? (data.earnings / summary.totalEarnings) * 100
                                : 0
                              return (
                                <tr key={nodeId} className="border-b border-border/50 hover:bg-surface-hover/50 transition-colors">
                                  <td className="py-4 px-4">
                                    <span className="text-sm font-mono bg-surface-hover px-2 py-1 rounded" style={{ color: 'var(--text-primary)' }}>
                                      {nodeId.substring(0, 8)}...
                                    </span>
                                  </td>
                                  <td className="py-4 px-4 text-right text-sm" style={{ color: 'var(--text-secondary)' }}>
                                    {data.jobs.toLocaleString()}
                                  </td>
                                  <td className="py-4 px-4 text-right text-sm text-accent font-semibold">
                                    {formatCurrency(data.earnings)}
                                  </td>
                                  <td className="py-4 px-4 text-right text-sm" style={{ color: 'var(--text-muted)' }}>
                                    {share.toFixed(1)}%
                                  </td>
                                </tr>
                              )
                            })}
                        </tbody>
                      </table>
                    </div>
                  </SectionCard>
                )}
              </>
            )}

            {activeTab === 'records' && (
              <SectionCard title="Earnings Records" icon={List}>
                <div className="flex items-center gap-4 mb-6">
                  <div>
                    <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>Market</label>
                    <select
                      value={marketFilter}
                      onChange={(e) => { setMarketFilter(e.target.value); setPage(1) }}
                      className="px-4 py-2.5 bg-background border border-border rounded-xl text-sm"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      <option value="">All Markets</option>
                      <option value="INTERNAL">Internal</option>
                      <option value="AKASH">Akash</option>
                      <option value="IONET">IO.net</option>
                      <option value="VASTAI">Vast.ai</option>
                    </select>
                  </div>
                  <Button onClick={loadRecords} variant="outline" size="sm" className="mt-5">
                    Apply
                  </Button>
                </div>

                {records.length > 0 ? (
                  <>
                    <div className="overflow-x-auto">
                      <table className="w-full">
                        <thead>
                          <tr className="border-b border-border">
                            <th className="text-left py-3 px-4 text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Date</th>
                            <th className="text-left py-3 px-4 text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Node</th>
                            <th className="text-left py-3 px-4 text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>GPU</th>
                            <th className="text-left py-3 px-4 text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Market</th>
                            <th className="text-right py-3 px-4 text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Jobs</th>
                            <th className="text-right py-3 px-4 text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>GPU Time</th>
                            <th className="text-right py-3 px-4 text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Earnings</th>
                          </tr>
                        </thead>
                        <tbody>
                          {records.map((record) => (
                            <tr key={record.id} className="border-b border-border/50 hover:bg-surface-hover/50 transition-colors">
                              <td className="py-4 px-4 text-sm" style={{ color: 'var(--text-primary)' }}>
                                {new Date(record.date).toLocaleDateString()}
                              </td>
                              <td className="py-4 px-4">
                                <div className="text-sm font-mono" style={{ color: 'var(--text-primary)' }}>
                                  {record.nodeId.substring(0, 8)}...
                                </div>
                                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                  {record.walletAddress.substring(0, 8)}...
                                </div>
                              </td>
                              <td className="py-4 px-4">
                                <span className={`px-2.5 py-1 text-xs rounded-lg font-medium text-white ${getTierColor(record.gpuTier)}`}>
                                  {record.gpuTier}
                                </span>
                              </td>
                              <td className="py-4 px-4">
                                <span className={`px-2.5 py-1 text-xs rounded-lg font-medium border ${getMarketBadgeStyle(record.market)}`}>
                                  {record.market}
                                </span>
                              </td>
                              <td className="py-4 px-4 text-right text-sm" style={{ color: 'var(--text-secondary)' }}>
                                {record.jobCount}
                              </td>
                              <td className="py-4 px-4 text-right text-sm" style={{ color: 'var(--text-secondary)' }}>
                                {formatHours(record.gpuSeconds)}
                              </td>
                              <td className="py-4 px-4 text-right text-sm text-accent font-semibold">
                                {formatCurrency(record.earnings)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div className="flex items-center justify-between mt-6 pt-4 border-t border-border">
                      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                        Showing {(page - 1) * limit + 1} - {Math.min(page * limit, recordsTotal)} of {recordsTotal}
                      </p>
                      <div className="flex gap-2">
                        <Button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} variant="outline" size="sm">
                          Previous
                        </Button>
                        <Button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages} variant="outline" size="sm">
                          Next
                        </Button>
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="text-sm py-8 text-center" style={{ color: 'var(--text-muted)' }}>No earnings records</p>
                )}
              </SectionCard>
            )}

            {activeTab === 'by-tier' && (
              <>
                <SectionCard title="Tier Earnings" icon={Briefcase}>
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
                    {GPU_TIERS.map((tier) => {
                      const data = byTier?.byTier?.[tier] ?? { earnings: 0, gpuHours: 0, jobCount: 0 }
                      const totalEarnings = byTier?.byTier
                        ? Object.values(byTier.byTier).reduce((s, d) => s + d.earnings, 0)
                        : 0
                      const percentage = totalEarnings > 0 ? (data.earnings / totalEarnings) * 100 : 0

                      return (
                        <div key={tier} className="p-4 rounded-md border border-border" style={{ background: 'var(--bg-elevated)' }}>
                          <div className="flex items-center gap-2 mb-4">
                            <span className={`w-3 h-3 rounded-full ${getTierColor(tier)}`} />
                            <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{tier}</span>
                          </div>
                          <p className="text-2xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>
                            {formatCurrency(data.earnings)}
                          </p>
                          <div className="space-y-1 text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
                            <div className="flex justify-between">
                              <span>Jobs</span>
                              <span>{data.jobCount.toLocaleString()}</span>
                            </div>
                            <div className="flex justify-between">
                              <span>GPU Time</span>
                              <span>{data.gpuHours.toFixed(1)}h</span>
                            </div>
                          </div>
                          <div className="h-2 bg-surface-hover rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${getTierColor(tier)}`} style={{ width: `${percentage}%` }} />
                          </div>
                          <p className="text-xs mt-2 text-right" style={{ color: 'var(--text-muted)' }}>
                            {percentage.toFixed(1)}% of total
                          </p>
                        </div>
                      )
                    })}
                  </div>
                </SectionCard>

                <SectionCard title="Tier Performance Comparison" icon={BarChart3}>
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-border">
                          <th className="text-left py-3 px-4 text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>GPU Tier</th>
                          <th className="text-right py-3 px-4 text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Total Earnings</th>
                          <th className="text-right py-3 px-4 text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>GPU Hours</th>
                          <th className="text-right py-3 px-4 text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Jobs</th>
                          <th className="text-right py-3 px-4 text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Avg/Job</th>
                          <th className="text-right py-3 px-4 text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Avg/Hour</th>
                        </tr>
                      </thead>
                      <tbody>
                        {GPU_TIERS.map((tier) => {
                          const data = byTier?.byTier?.[tier] ?? { earnings: 0, gpuHours: 0, jobCount: 0 }
                          const avgPerJob = data.jobCount > 0 ? data.earnings / data.jobCount : 0
                          const avgPerHour = data.gpuHours > 0 ? data.earnings / data.gpuHours : 0

                          return (
                            <tr key={tier} className="border-b border-border/50 hover:bg-surface-hover/50 transition-colors">
                              <td className="py-4 px-4">
                                <div className="flex items-center gap-2">
                                  <span className={`w-3 h-3 rounded-full ${getTierColor(tier)}`} />
                                  <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{tier}</span>
                                </div>
                              </td>
                              <td className="py-4 px-4 text-right text-sm text-accent font-semibold">
                                {formatCurrency(data.earnings)}
                              </td>
                              <td className="py-4 px-4 text-right text-sm" style={{ color: 'var(--text-secondary)' }}>
                                {data.gpuHours.toFixed(1)}h
                              </td>
                              <td className="py-4 px-4 text-right text-sm" style={{ color: 'var(--text-secondary)' }}>
                                {data.jobCount.toLocaleString()}
                              </td>
                              <td className="py-4 px-4 text-right text-sm" style={{ color: 'var(--text-secondary)' }}>
                                {formatCurrency(avgPerJob)}
                              </td>
                              <td className="py-4 px-4 text-right text-sm" style={{ color: 'var(--text-secondary)' }}>
                                {formatCurrency(avgPerHour)}/h
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </SectionCard>
              </>
            )}
          </>
        )}
      </DashboardMainColumn>

      <DashboardRightRail>
        <SectionCard title="Quick Stats" icon={Briefcase}>
          <div className="space-y-3">
            <div className="flex justify-between items-baseline">
              <span className="font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-muted)' }}>Total Jobs</span>
              <span className="font-display text-sm" style={{ color: 'var(--text-primary)' }}>{(summary?.totalJobs ?? 0).toLocaleString()}</span>
            </div>
            <div className="flex justify-between items-baseline">
              <span className="font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-muted)' }}>GPU Time</span>
              <span className="font-display text-sm" style={{ color: 'var(--text-primary)' }}>{formatHours(summary?.totalGpuSeconds ?? 0)}</span>
            </div>
            <div className="flex justify-between items-baseline">
              <span className="font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-muted)' }}>Markets</span>
              <span className="font-display text-sm" style={{ color: 'var(--text-primary)' }}>{Object.keys(summary?.byMarket ?? {}).length}</span>
            </div>
          </div>
        </SectionCard>
      </DashboardRightRail>
    </DashboardShell>
  )
}
