'use client'

import { useEffect, useState, useCallback } from 'react'
import { motion } from 'framer-motion'
import { TrendingUp, BarChart3, DollarSign, Server, Cpu, Star, Globe, Shield, RefreshCw, AlertTriangle, Clock } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { api } from '@/lib/api'

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

interface Rate {
  market: string
  gpuTier: string
  ratePerHour: number
  ratePerDay: number
  available: boolean
  enabled: boolean
  fetchedAt: string
}

interface RateHistory {
  ratePerHour: number
  ratePerDay: number
  fetchedAt: string
}

const GPU_TIER_ORDER = ['H100', 'H200', 'B200', 'B300', 'GB300']
const MARKETS = ['AKASH', 'IONET', 'VASTAI']

const MARKET_LABEL: Record<string, string> = { AKASH: 'Akash', IONET: 'IO.net', VASTAI: 'Vast.ai' }
const MARKET_BUTTON_BG: Record<string, string> = {
  AKASH: 'bg-accent-blue text-white',
  IONET: 'bg-accent-purple text-white',
  VASTAI: 'bg-amber-500 text-white',
}

export default function RatesPage() {
  const [rates, setRates] = useState<Rate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)

  // History state
  const [selectedTier, setSelectedTier] = useState('H100')
  const [selectedMarket, setSelectedMarket] = useState('AKASH')
  const [history, setHistory] = useState<RateHistory[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const data = await api.rates.history({ gpuTier: selectedTier, market: selectedMarket, limit: 48 })
      setHistory(data.history)
    } catch {
      setHistory([])
    } finally {
      setHistoryLoading(false)
    }
  }, [selectedTier, selectedMarket])

  useEffect(() => {
    loadHistory()
  }, [loadHistory])

  useEffect(() => {
    loadRates()
    const interval = setInterval(loadRates, 30000)
    return () => clearInterval(interval)
  }, [])

  async function loadRates() {
    try {
      const data = await api.rates.current()
      setRates(data.rates)
      setLastUpdated(data.lastUpdated)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load rates')
    } finally {
      setLoading(false)
    }
  }

  // Group rates by GPU tier
  const ratesByTier = GPU_TIER_ORDER.map((tier) => {
    const tierRates = rates.filter((r) => r.gpuTier === tier)
    return {
      tier,
      internal: tierRates.find((r) => r.market === 'INTERNAL'),
      akash: tierRates.find((r) => r.market === 'AKASH'),
      ionet: tierRates.find((r) => r.market === 'IONET'),
      vastai: tierRates.find((r) => r.market === 'VASTAI'),
    }
  })

  // Calculate summary stats
  const avgRate = (market: string) => {
    const filtered = rates.filter(r => r.market === market && r.available)
    return filtered.length > 0 ? filtered.reduce((sum, r) => sum + r.ratePerDay, 0) / filtered.length : 0
  }
  const avgAkashRate = avgRate('AKASH')
  const avgIonetRate = avgRate('IONET')
  const avgVastaiRate = avgRate('VASTAI')
  const avgInternalRate = rates.filter(r => r.market === 'INTERNAL').reduce((sum, r) => sum + r.ratePerDay, 0) /
    Math.max(1, rates.filter(r => r.market === 'INTERNAL').length)

  return (
    <motion.div variants={container} initial="hidden" animate="show" className="space-y-8">
      {/* Header */}
      <motion.div variants={item}>
        <div className="dash-header">
          <div className="dash-header-left">
            <h1><TrendingUp size={28} /> Market Rates</h1>
            {lastUpdated && (
              <span className="dash-date-badge">
                <Clock size={14} />
                {new Date(lastUpdated).toLocaleTimeString()}
              </span>
            )}
          </div>
          <div className="dash-header-right">
            <button className="dash-refresh-btn" onClick={loadRates} title="Refresh rates">
              <RefreshCw className="w-5 h-5" />
            </button>
          </div>
        </div>
      </motion.div>

      {error && (
        <motion.div variants={item} className="p-4 bg-error/10 border border-error/20 rounded-xl flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-error/10 flex items-center justify-center flex-shrink-0">
            <AlertTriangle className="w-5 h-5 text-error" />
          </div>
          <p className="text-error text-sm">{error}</p>
        </motion.div>
      )}

      {loading ? (
        <div className="flex flex-col items-center justify-center py-20">
          <div className="w-12 h-12 rounded-xl bg-surface-hover flex items-center justify-center mb-4">
            <div className="w-6 h-6 border-2 border-accent-purple border-t-transparent rounded-full animate-spin" />
          </div>
          <p className="text-text-muted">Loading rates...</p>
        </div>
      ) : (
        <>
          {/* KPI Blocks */}
          <motion.div variants={item} className="stat-blocks">
            <div className="stat-block green">
              <div className="stat-icon"><Server size={20} /></div>
              <div className="stat-content">
                <span className="stat-value">{rates.filter(r => r.available).length}</span>
                <span className="stat-label">Markets Active</span>
              </div>
            </div>
            <div className="stat-block blue">
              <div className="stat-icon"><BarChart3 size={20} /></div>
              <div className="stat-content">
                <span className="stat-value">${avgAkashRate.toFixed(2)}/day</span>
                <span className="stat-label">Akash Avg Rate</span>
              </div>
            </div>
            <div className="stat-block purple">
              <div className="stat-icon"><BarChart3 size={20} /></div>
              <div className="stat-content">
                <span className="stat-value">${avgIonetRate.toFixed(2)}/day</span>
                <span className="stat-label">IO.net Avg Rate</span>
              </div>
            </div>
            <div className="stat-block" style={{ background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.2)' }}>
              <div className="stat-icon" style={{ background: 'rgba(234,179,8,0.15)', color: '#eab308' }}><BarChart3 size={20} /></div>
              <div className="stat-content">
                <span className="stat-value">${avgVastaiRate.toFixed(2)}/day</span>
                <span className="stat-label">Vast.ai Avg Rate</span>
              </div>
            </div>
            <div className="stat-block orange">
              <div className="stat-icon"><DollarSign size={20} /></div>
              <div className="stat-content">
                <span className="stat-value">${avgInternalRate.toFixed(2)}/day</span>
                <span className="stat-label">Internal Rate</span>
              </div>
            </div>
          </motion.div>

          {/* GPU Tier Cards */}
          <motion.div variants={item} className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {ratesByTier.map(({ tier, internal, akash, ionet, vastai }) => {
              const externalRates = [
                akash?.available ? akash.ratePerDay : 0,
                ionet?.available ? ionet.ratePerDay : 0,
                vastai?.available ? vastai.ratePerDay : 0,
              ].filter((r) => r > 0)
              const bestExternal = externalRates.length > 0 ? Math.max(...externalRates) : null
              const externalDiscount = internal && bestExternal ? ((1 - bestExternal / internal.ratePerDay) * 100) : null

              return (
                <Card key={tier} variant="glass" className="group" style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
                  <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-accent/20 to-accent-purple/20 flex items-center justify-center">
                        <Cpu className="w-6 h-6 text-accent" />
                      </div>
                      <div>
                        <h3 className="text-lg font-bold text-text-primary">{tier}</h3>
                        <p className="text-xs text-text-muted">NVIDIA {tier}</p>
                      </div>
                    </div>
                    {externalDiscount && externalDiscount > 0 && (
                      <span className="px-2.5 py-1 text-xs font-medium bg-error/10 text-error rounded-lg">
                        -{externalDiscount.toFixed(0)}% external
                      </span>
                    )}
                  </div>

                  <div className="space-y-3">
                    {/* Internal Rate */}
                    <div className="p-4 bg-accent/5 border border-accent/20 rounded-xl">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-text-muted">Internal (Retail)</span>
                        <span className="text-lg font-bold text-accent">
                          ${internal?.ratePerDay.toFixed(2) ?? '-'}
                          <span className="text-xs font-normal text-text-muted">/day</span>
                        </span>
                      </div>
                    </div>

                    {/* External Rates */}
                    <div className="grid grid-cols-3 gap-2">
                      <div className="p-3 bg-accent-blue/5 border border-accent-blue/20 rounded-xl">
                        <span className="text-xs text-text-muted block mb-1">Akash</span>
                        {akash?.available ? (
                          <span className="text-sm font-bold text-accent-blue">
                            ${akash.ratePerDay.toFixed(2)}
                          </span>
                        ) : (
                          <span className="text-sm text-text-muted">N/A</span>
                        )}
                      </div>
                      <div className="p-3 bg-accent-purple/5 border border-accent-purple/20 rounded-xl">
                        <span className="text-xs text-text-muted block mb-1">IO.net</span>
                        {ionet?.available ? (
                          <span className="text-sm font-bold text-accent-purple">
                            ${ionet.ratePerDay.toFixed(2)}
                          </span>
                        ) : (
                          <span className="text-sm text-text-muted">N/A</span>
                        )}
                      </div>
                      <div className="p-3 rounded-xl" style={{ background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.2)' }}>
                        <span className="text-xs text-text-muted block mb-1">Vast.ai</span>
                        {vastai?.available ? (
                          <span className="text-sm font-bold" style={{ color: '#eab308' }}>
                            ${vastai.ratePerDay.toFixed(2)}
                          </span>
                        ) : (
                          <span className="text-sm text-text-muted">N/A</span>
                        )}
                      </div>
                    </div>

                    {/* Best External */}
                    {bestExternal && internal && (
                      <div className="pt-3 border-t border-border">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-text-muted">Best External</span>
                          <span className="text-text-primary font-medium">
                            ${bestExternal.toFixed(2)}/day
                            <span className="text-text-muted ml-2">
                              ({((bestExternal / internal.ratePerDay) * 100).toFixed(0)}% of retail)
                            </span>
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                </Card>
              )
            })}
          </motion.div>

          {/* Rate History Chart */}
          <motion.div variants={item}>
          <Card variant="glass" title="Rate History" description="Track rate changes over time">
            <div className="space-y-6 mt-4">
              {/* Tier and Market Selection */}
              <div className="flex items-center gap-4 flex-wrap">
                <div>
                  <label className="text-xs text-text-muted block mb-2 font-medium">GPU Tier</label>
                  <div className="flex gap-2">
                    {GPU_TIER_ORDER.map((tier) => (
                      <button
                        key={tier}
                        onClick={() => setSelectedTier(tier)}
                        className={`px-3 py-2 text-sm rounded-lg font-medium transition-all ${
                          selectedTier === tier
                            ? 'bg-accent text-white'
                            : 'bg-surface text-text-secondary hover:bg-surface-hover'
                        }`}
                      >
                        {tier}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-xs text-text-muted block mb-2 font-medium">Market</label>
                  <div className="flex gap-2">
                    {MARKETS.map((market) => (
                      <button
                        key={market}
                        onClick={() => setSelectedMarket(market)}
                        className={`px-4 py-2 text-sm rounded-lg font-medium transition-all ${
                          selectedMarket === market
                            ? MARKET_BUTTON_BG[market]
                            : 'bg-surface text-text-secondary hover:bg-surface-hover'
                        }`}
                      >
                        {market}
                      </button>
                    ))}
                  </div>
                </div>
                <Button onClick={loadHistory} variant="secondary" size="sm" className="mt-5" icon={<RefreshCw className="w-4 h-4" />}>
                  Refresh
                </Button>
              </div>

              {/* Chart */}
              {historyLoading ? (
                <div className="h-48 flex items-center justify-center">
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                    <p className="text-text-muted text-sm">Loading history...</p>
                  </div>
                </div>
              ) : history.length === 0 ? (
                <div className="h-48 flex items-center justify-center">
                  <div className="text-center">
                    <div className="w-12 h-12 rounded-xl bg-surface-hover flex items-center justify-center mx-auto mb-3">
                      <BarChart3 className="w-6 h-6 text-text-muted" />
                    </div>
                    <p className="text-text-muted">No rate history available for {selectedTier} on {selectedMarket}</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Bar Chart */}
                  <div className="h-48 flex items-end gap-1 px-2 bg-surface/50 rounded-xl p-4">
                    {(() => {
                      const maxRate = Math.max(...history.map(h => h.ratePerDay))
                      const minRate = Math.min(...history.map(h => h.ratePerDay))
                      return history.slice(-24).map((h, i) => {
                        const height = maxRate > 0 ? (h.ratePerDay / maxRate) * 100 : 0
                        const isHighest = h.ratePerDay === maxRate
                        const isLowest = h.ratePerDay === minRate
                        const barColor = selectedMarket === 'AKASH'
                          ? isHighest ? 'bg-accent' : isLowest ? 'bg-error' : 'bg-accent-blue/60'
                          : isHighest ? 'bg-accent' : isLowest ? 'bg-error' : 'bg-accent-purple/60'
                        return (
                          <div
                            key={i}
                            className="flex-1 min-w-0 group relative"
                          >
                            <div
                              className={`w-full rounded-t transition-all ${barColor} group-hover:opacity-80`}
                              style={{ height: `${height}%`, minHeight: '4px' }}
                            />
                            {/* Tooltip */}
                            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 bg-surface border border-border rounded-lg text-xs whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-10 pointer-events-none shadow-lg">
                              <p className="text-text-primary font-bold">${h.ratePerDay.toFixed(2)}/day</p>
                              <p className="text-text-muted">{new Date(h.fetchedAt).toLocaleString()}</p>
                            </div>
                          </div>
                        )
                      })
                    })()}
                  </div>

                  {/* Stats */}
                  <div className="grid grid-cols-4 gap-4">
                    <div className="p-4 bg-surface rounded-xl text-center">
                      <p className="text-xs text-text-muted mb-1">Current</p>
                      <p className="text-lg font-bold text-text-primary">
                        ${history[history.length - 1]?.ratePerDay.toFixed(2) ?? '-'}
                      </p>
                    </div>
                    <div className="p-4 bg-accent/5 border border-accent/20 rounded-xl text-center">
                      <p className="text-xs text-text-muted mb-1">High</p>
                      <p className="text-lg font-bold text-accent">
                        ${Math.max(...history.map(h => h.ratePerDay)).toFixed(2)}
                      </p>
                    </div>
                    <div className="p-4 bg-error/5 border border-error/20 rounded-xl text-center">
                      <p className="text-xs text-text-muted mb-1">Low</p>
                      <p className="text-lg font-bold text-error">
                        ${Math.min(...history.map(h => h.ratePerDay)).toFixed(2)}
                      </p>
                    </div>
                    <div className="p-4 bg-surface rounded-xl text-center">
                      <p className="text-xs text-text-muted mb-1">Average</p>
                      <p className="text-lg font-bold text-text-primary">
                        ${(history.reduce((s, h) => s + h.ratePerDay, 0) / history.length).toFixed(2)}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </Card>
          </motion.div>

          {/* Info Card */}
          <motion.div variants={item}>
          <Card variant="glass">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="flex gap-4">
                <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center flex-shrink-0">
                  <Star className="w-5 h-5 text-accent" />
                </div>
                <div>
                  <h4 className="font-medium text-text-primary mb-1">Internal Rate</h4>
                  <p className="text-sm text-text-muted">Premium retail rate for TokenOS agent tasks with priority routing</p>
                </div>
              </div>
              <div className="flex gap-4">
                <div className="w-10 h-10 rounded-lg bg-accent-blue/10 flex items-center justify-center flex-shrink-0">
                  <Globe className="w-5 h-5 text-accent-blue" />
                </div>
                <div>
                  <h4 className="font-medium text-text-primary mb-1">External Rates</h4>
                  <p className="text-sm text-text-muted">Market rates from Akash and IO.net used when no internal demand</p>
                </div>
              </div>
              <div className="flex gap-4">
                <div className="w-10 h-10 rounded-lg bg-warning/10 flex items-center justify-center flex-shrink-0">
                  <Shield className="w-5 h-5 text-warning" />
                </div>
                <div>
                  <h4 className="font-medium text-text-primary mb-1">Yield Floor</h4>
                  <p className="text-sm text-text-muted">Minimum guaranteed rate. External rates below floor are boosted</p>
                </div>
              </div>
            </div>
          </Card>
          </motion.div>
        </>
      )}
    </motion.div>
  )
}

// Icons
function RefreshIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
    </svg>
  )
}

function AlertIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
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

function ServerIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />
    </svg>
  )
}

function GpuIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
    </svg>
  )
}

function StarIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
    </svg>
  )
}

function GlobeIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function ShieldIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
    </svg>
  )
}
