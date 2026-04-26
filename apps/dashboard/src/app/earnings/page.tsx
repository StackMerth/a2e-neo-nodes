'use client'

import { useEffect, useState, useCallback } from 'react'
import { motion } from 'framer-motion'
import { DollarSign, BarChart3, TrendingUp, Clock, Briefcase, Server, List, RefreshCw, AlertTriangle } from 'lucide-react'
import { Card, StatCard } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { DistributionBar } from '@/components/ui/ProgressBar'
import { EmptyState } from '@/components/ui/EmptyState'
import { api } from '@/lib/api'

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

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
  const [error, setError] = useState<string | null>(null)
  const [days, setDays] = useState(7)

  // Filters for records tab
  const [marketFilter, setMarketFilter] = useState<string>('')
  const [page, setPage] = useState(1)
  const limit = 20

  const loadEarnings = useCallback(async () => {
    setLoading(true)
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
    <motion.div variants={container} initial="hidden" animate="show" className="space-y-8">
      {/* Header */}
      <motion.div variants={item} className="dash-header">
        <div className="dash-header-left">
          <h1><DollarSign size={28} /> Earnings</h1>
        </div>
        <div className="dash-header-right">
          <button className="dash-refresh-btn" onClick={loadEarnings} title="Refresh data">
            <RefreshCw size={16} />
          </button>
        </div>
      </motion.div>

      {/* KPI Stat Blocks */}
      <motion.div variants={item} className="stat-blocks">
        <div className="stat-block green">
          <div className="stat-icon"><DollarSign size={20} /></div>
          <div className="stat-content">
            <span className="stat-value">{formatCurrency(summary?.totalEarnings ?? 0)}</span>
            <span className="stat-label">Total Earnings</span>
          </div>
        </div>
        <div className="stat-block blue">
          <div className="stat-icon"><TrendingUp size={20} /></div>
          <div className="stat-content">
            <span className="stat-value">{formatCurrency(byMarket?.total.earnings ?? 0)}</span>
            <span className="stat-label">Last {days}d</span>
          </div>
        </div>
        <div className="stat-block amber">
          <div className="stat-icon"><Briefcase size={20} /></div>
          <div className="stat-content">
            <span className="stat-value">{(summary?.totalJobs ?? 0).toLocaleString()}</span>
            <span className="stat-label">Job Count</span>
          </div>
        </div>
        <div className="stat-block purple">
          <div className="stat-icon"><Clock size={20} /></div>
          <div className="stat-content">
            <span className="stat-value">{formatHours(summary?.totalGpuSeconds ?? 0)}</span>
            <span className="stat-label">GPU Time</span>
          </div>
        </div>
      </motion.div>

      {/* Actions Bar */}
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
                  : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-text-primary focus:outline-none focus:border-accent"
          >
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <Button onClick={loadEarnings} variant="outline" size="sm" icon={<RefreshCw className="w-4 h-4" />}>
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-error/10 border border-error/20 rounded-xl flex items-center gap-3 animate-slideUp">
          <div className="w-8 h-8 rounded-lg bg-error/20 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-4 h-4 text-error" />
          </div>
          <p className="text-error text-sm">{error}</p>
        </div>
      )}

      {loading && activeTab !== 'records' ? (
        <div className="flex items-center justify-center h-64">
          <div className="flex flex-col items-center gap-3">
            <div className="w-10 h-10 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            <p className="text-text-muted">Loading earnings data...</p>
          </div>
        </div>
      ) : (
        <>
          {/* OVERVIEW TAB */}
          {activeTab === 'overview' && (
            <>
              {/* Market Distribution */}
              {byMarket && byMarket.total.earnings > 0 && (
                <Card variant="glass" hover={false}>
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h3 className="text-sm font-medium text-text-primary">Revenue by Market</h3>
                      <p className="text-xs text-text-muted">Earnings breakdown for the last {days} days</p>
                    </div>
                    <span className="text-lg font-bold text-accent">{formatCurrency(byMarket.total.earnings)}</span>
                  </div>
                  <DistributionBar segments={marketDistribution} size="lg" showLegend />
                </Card>
              )}

              {/* Market Cards */}
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
                    <Card key={market} variant="glass">
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
                      <p className="text-3xl font-bold text-text-primary mb-2">
                        {formatCurrency(data.earnings)}
                      </p>
                      <div className="flex items-center justify-between text-xs text-text-muted mb-3">
                        <span>{data.jobCount} jobs</span>
                        <span>{data.gpuHours.toFixed(1)}h GPU time</span>
                      </div>
                      <div className="h-2 bg-surface-hover rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${barCls}`} style={barStyle} />
                      </div>
                      <p className="text-xs text-text-muted mt-2 text-right">
                        {percentage.toFixed(1)}% of total
                      </p>
                    </Card>
                  )
                })}
                {(!byMarket?.byMarket || Object.keys(byMarket.byMarket).length === 0) && (
                  <div className="col-span-3">
                    <EmptyState
                      icon={<BarChart3 className="w-8 h-8" />}
                      title="No earnings data"
                      description="Earnings will appear here once jobs are completed"
                    />
                  </div>
                )}
              </div>

              {/* Earnings Trend Chart */}
              <Card variant="glass" hover={false}>
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent to-emerald-400 flex items-center justify-center">
                    <BarChart3 className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-text-primary">Earnings Trend</h3>
                    <p className="text-xs text-text-muted">Daily earnings over time</p>
                  </div>
                </div>

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
                                <p className="text-text-primary font-semibold">{formatCurrency(t.earnings)}</p>
                                <p className="text-text-muted">{t.jobCount} jobs</p>
                                <p className="text-text-muted">{new Date(t.date).toLocaleDateString()}</p>
                              </div>
                            </div>
                          )
                        })
                      })()}
                    </div>
                    <div className="flex justify-between px-2 mt-2 text-xs text-text-muted">
                      <span>{new Date(trends.trend[0]?.date).toLocaleDateString()}</span>
                      <span>{new Date(trends.trend[trends.trend.length - 1]?.date).toLocaleDateString()}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm border-t border-border pt-4 mt-4">
                      <div>
                        <span className="text-text-muted">Total:</span>{' '}
                        <span className="font-semibold text-text-primary">{formatCurrency(trends.trend.reduce((s, t) => s + t.earnings, 0))}</span>
                      </div>
                      <div>
                        <span className="text-accent">Best Day:</span>{' '}
                        <span className="font-semibold text-text-primary">{formatCurrency(Math.max(...trends.trend.map(t => t.earnings)))}</span>
                      </div>
                      <div>
                        <span className="text-text-muted">Avg/Day:</span>{' '}
                        <span className="font-semibold text-text-primary">{formatCurrency(trends.trend.reduce((s, t) => s + t.earnings, 0) / trends.trend.length)}</span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <EmptyState
                    icon={<BarChart3 className="w-8 h-8" />}
                    title="No trend data"
                    description="Trend data will appear once you have earnings"
                  />
                )}
              </Card>

              {/* Top Earning Nodes */}
              {summary?.byNode && Object.keys(summary.byNode).length > 0 && (
                <Card variant="glass" hover={false}>
                  <div className="flex items-center gap-3 mb-6">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-purple-400 flex items-center justify-center">
                      <Server className="w-5 h-5 text-white" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-text-primary">Top Earning Nodes</h3>
                      <p className="text-xs text-text-muted">Nodes sorted by earnings</p>
                    </div>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-border">
                          <th className="text-left py-3 px-4 text-xs text-text-muted uppercase tracking-wider">Node ID</th>
                          <th className="text-right py-3 px-4 text-xs text-text-muted uppercase tracking-wider">Jobs</th>
                          <th className="text-right py-3 px-4 text-xs text-text-muted uppercase tracking-wider">Earnings</th>
                          <th className="text-right py-3 px-4 text-xs text-text-muted uppercase tracking-wider">Share</th>
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
                                  <span className="text-sm font-mono text-text-primary bg-surface-hover px-2 py-1 rounded">
                                    {nodeId.substring(0, 8)}...
                                  </span>
                                </td>
                                <td className="py-4 px-4 text-right text-sm text-text-secondary">
                                  {data.jobs.toLocaleString()}
                                </td>
                                <td className="py-4 px-4 text-right text-sm text-accent font-semibold">
                                  {formatCurrency(data.earnings)}
                                </td>
                                <td className="py-4 px-4 text-right text-sm text-text-muted">
                                  {share.toFixed(1)}%
                                </td>
                              </tr>
                            )
                          })}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}
            </>
          )}

          {/* RECORDS TAB */}
          {activeTab === 'records' && (
            <Card variant="glass" hover={false}>
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-blue-400 flex items-center justify-center">
                  <List className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h3 className="font-semibold text-text-primary">Earnings Records</h3>
                  <p className="text-xs text-text-muted">Individual earning entries</p>
                </div>
              </div>

              {/* Filters */}
              <div className="flex items-center gap-4 mb-6">
                <div>
                  <label className="text-xs text-text-muted block mb-1">Market</label>
                  <select
                    value={marketFilter}
                    onChange={(e) => { setMarketFilter(e.target.value); setPage(1) }}
                    className="px-4 py-2.5 bg-background border border-border rounded-xl text-sm text-text-primary"
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
                          <th className="text-left py-3 px-4 text-xs text-text-muted uppercase tracking-wider">Date</th>
                          <th className="text-left py-3 px-4 text-xs text-text-muted uppercase tracking-wider">Node</th>
                          <th className="text-left py-3 px-4 text-xs text-text-muted uppercase tracking-wider">GPU</th>
                          <th className="text-left py-3 px-4 text-xs text-text-muted uppercase tracking-wider">Market</th>
                          <th className="text-right py-3 px-4 text-xs text-text-muted uppercase tracking-wider">Jobs</th>
                          <th className="text-right py-3 px-4 text-xs text-text-muted uppercase tracking-wider">GPU Time</th>
                          <th className="text-right py-3 px-4 text-xs text-text-muted uppercase tracking-wider">Earnings</th>
                        </tr>
                      </thead>
                      <tbody>
                        {records.map((record) => (
                          <tr key={record.id} className="border-b border-border/50 hover:bg-surface-hover/50 transition-colors">
                            <td className="py-4 px-4 text-sm text-text-primary">
                              {new Date(record.date).toLocaleDateString()}
                            </td>
                            <td className="py-4 px-4">
                              <div className="text-sm font-mono text-text-primary">
                                {record.nodeId.substring(0, 8)}...
                              </div>
                              <div className="text-xs text-text-muted">
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
                            <td className="py-4 px-4 text-right text-sm text-text-secondary">
                              {record.jobCount}
                            </td>
                            <td className="py-4 px-4 text-right text-sm text-text-secondary">
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

                  {/* Pagination */}
                  <div className="flex items-center justify-between mt-6 pt-4 border-t border-border">
                    <p className="text-sm text-text-muted">
                      Showing {(page - 1) * limit + 1} - {Math.min(page * limit, recordsTotal)} of {recordsTotal}
                    </p>
                    <div className="flex gap-2">
                      <Button
                        onClick={() => setPage(p => Math.max(1, p - 1))}
                        disabled={page === 1}
                        variant="outline"
                        size="sm"
                      >
                        Previous
                      </Button>
                      <Button
                        onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                        disabled={page >= totalPages}
                        variant="outline"
                        size="sm"
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                </>
              ) : (
                <EmptyState
                  icon={<List className="w-8 h-8" />}
                  title="No earnings records"
                  description="Earning records will appear here once jobs are completed"
                />
              )}
            </Card>
          )}

          {/* BY TIER TAB */}
          {activeTab === 'by-tier' && (
            <>
              {/* Tier Cards */}
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
                {GPU_TIERS.map((tier) => {
                  const data = byTier?.byTier?.[tier] ?? { earnings: 0, gpuHours: 0, jobCount: 0 }
                  const totalEarnings = byTier?.byTier
                    ? Object.values(byTier.byTier).reduce((s, d) => s + d.earnings, 0)
                    : 0
                  const percentage = totalEarnings > 0 ? (data.earnings / totalEarnings) * 100 : 0

                  return (
                    <Card key={tier} variant="glass">
                      <div className="flex items-center gap-2 mb-4">
                        <span className={`w-3 h-3 rounded-full ${getTierColor(tier)}`} />
                        <span className="font-semibold text-text-primary">{tier}</span>
                      </div>
                      <p className="text-2xl font-bold text-text-primary mb-2">
                        {formatCurrency(data.earnings)}
                      </p>
                      <div className="space-y-1 text-xs text-text-muted mb-3">
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
                        <div
                          className={`h-full rounded-full ${getTierColor(tier)}`}
                          style={{ width: `${percentage}%` }}
                        />
                      </div>
                      <p className="text-xs text-text-muted mt-2 text-right">
                        {percentage.toFixed(1)}% of total
                      </p>
                    </Card>
                  )
                })}
              </div>

              {/* Tier Comparison Table */}
              <Card variant="glass" hover={false}>
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 to-orange-400 flex items-center justify-center">
                    <BarChart3 className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-text-primary">Tier Performance Comparison</h3>
                    <p className="text-xs text-text-muted">Metrics per GPU tier</p>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left py-3 px-4 text-xs text-text-muted uppercase tracking-wider">GPU Tier</th>
                        <th className="text-right py-3 px-4 text-xs text-text-muted uppercase tracking-wider">Total Earnings</th>
                        <th className="text-right py-3 px-4 text-xs text-text-muted uppercase tracking-wider">GPU Hours</th>
                        <th className="text-right py-3 px-4 text-xs text-text-muted uppercase tracking-wider">Jobs</th>
                        <th className="text-right py-3 px-4 text-xs text-text-muted uppercase tracking-wider">Avg/Job</th>
                        <th className="text-right py-3 px-4 text-xs text-text-muted uppercase tracking-wider">Avg/Hour</th>
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
                                <span className="text-sm font-medium text-text-primary">{tier}</span>
                              </div>
                            </td>
                            <td className="py-4 px-4 text-right text-sm text-accent font-semibold">
                              {formatCurrency(data.earnings)}
                            </td>
                            <td className="py-4 px-4 text-right text-sm text-text-secondary">
                              {data.gpuHours.toFixed(1)}h
                            </td>
                            <td className="py-4 px-4 text-right text-sm text-text-secondary">
                              {data.jobCount.toLocaleString()}
                            </td>
                            <td className="py-4 px-4 text-right text-sm text-text-secondary">
                              {formatCurrency(avgPerJob)}
                            </td>
                            <td className="py-4 px-4 text-right text-sm text-text-secondary">
                              {formatCurrency(avgPerHour)}/h
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            </>
          )}
        </>
      )}
    </motion.div>
  )
}

// =============================================================================
// ICONS
// =============================================================================

function TrendingUpIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
    </svg>
  )
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
    </svg>
  )
}

function DollarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function BriefcaseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  )
}

function ChartIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
    </svg>
  )
}

function AlertIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
    </svg>
  )
}

function ServerIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
    </svg>
  )
}

function ListIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
    </svg>
  )
}
