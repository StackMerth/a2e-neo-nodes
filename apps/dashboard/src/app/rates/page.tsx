'use client'

import { useEffect, useState, useCallback } from 'react'
import { TrendingUp, BarChart3, DollarSign, Server, Cpu, Star, Globe, Shield, RefreshCw, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { api } from '@/lib/api'
import {
  DashboardShell,
  FormCard,
  FormSection,
} from '@/components/dashboard/FuturisticShell'

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

const MARKET_BUTTON_BG: Record<string, string> = {
  AKASH: 'bg-accent-blue text-white',
  IONET: 'bg-accent-purple text-white',
  VASTAI: 'bg-amber-500 text-white',
}

export default function RatesPage() {
  const [rates, setRates] = useState<Rate[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
    const interval = setInterval(() => loadRates(), 30000)
    return () => clearInterval(interval)
  }, [])

  async function loadRates(isRefresh = false) {
    if (isRefresh) setRefreshing(true)
    try {
      const data = await api.rates.current()
      setRates(data.rates)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load rates')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

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

  return (
    <DashboardShell
      title="Market Rates"
      subtitle="Per-tier rate configuration"
      liveLabel="LIVE"
      onRefresh={() => loadRates(true)}
      refreshing={refreshing}
    >
      <div className="lg:col-span-3 max-w-5xl mx-auto w-full space-y-6">
        {error && (
          <div className="p-4 bg-error/10 border border-error/20 rounded-xl flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-error/10 flex items-center justify-center flex-shrink-0">
              <AlertTriangle className="w-5 h-5 text-error" />
            </div>
            <p className="text-error text-sm">{error}</p>
          </div>
        )}

        {!loading && (
          <>
            <FormCard title="GPU Tiers" description="Current rates across all markets" icon={Cpu}>
              <FormSection>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                  {ratesByTier.map(({ tier, internal, akash, ionet, vastai }) => {
                    const externalRates = [
                      akash?.available ? akash.ratePerDay : 0,
                      ionet?.available ? ionet.ratePerDay : 0,
                      vastai?.available ? vastai.ratePerDay : 0,
                    ].filter((r) => r > 0)
                    const bestExternal = externalRates.length > 0 ? Math.max(...externalRates) : null
                    const externalDiscount = internal && bestExternal ? ((1 - bestExternal / internal.ratePerDay) * 100) : null

                    return (
                      <div key={tier} className="rounded-md border border-border p-5" style={{ background: 'var(--bg-elevated)' }}>
                        <div className="flex items-center justify-between mb-6">
                          <div className="flex items-center gap-3">
                            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-accent/20 to-accent-purple/20 flex items-center justify-center">
                              <Cpu className="w-6 h-6 text-accent" />
                            </div>
                            <div>
                              <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{tier}</h3>
                              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>NVIDIA {tier}</p>
                            </div>
                          </div>
                          {externalDiscount && externalDiscount > 0 && (
                            <span className="px-2.5 py-1 text-xs font-medium bg-error/10 text-error rounded-lg">
                              -{externalDiscount.toFixed(0)}% external
                            </span>
                          )}
                        </div>

                        <div className="space-y-3">
                          <div className="p-4 bg-accent/5 border border-accent/20 rounded-xl">
                            <div className="flex items-center justify-between">
                              <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Internal (Retail)</span>
                              <span className="text-lg font-bold text-accent">
                                ${internal?.ratePerDay.toFixed(2) ?? '-'}
                                <span className="text-xs font-normal ml-1" style={{ color: 'var(--text-muted)' }}>/day</span>
                              </span>
                            </div>
                          </div>

                          <div className="grid grid-cols-3 gap-2">
                            <div className="p-3 bg-accent-blue/5 border border-accent-blue/20 rounded-xl">
                              <span className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>Akash</span>
                              {akash?.available ? (
                                <span className="text-sm font-bold text-accent-blue">${akash.ratePerDay.toFixed(2)}</span>
                              ) : (
                                <span className="text-sm" style={{ color: 'var(--text-muted)' }}>N/A</span>
                              )}
                            </div>
                            <div className="p-3 bg-accent-purple/5 border border-accent-purple/20 rounded-xl">
                              <span className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>IO.net</span>
                              {ionet?.available ? (
                                <span className="text-sm font-bold text-accent-purple">${ionet.ratePerDay.toFixed(2)}</span>
                              ) : (
                                <span className="text-sm" style={{ color: 'var(--text-muted)' }}>N/A</span>
                              )}
                            </div>
                            <div className="p-3 rounded-xl" style={{ background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.2)' }}>
                              <span className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>Vast.ai</span>
                              {vastai?.available ? (
                                <span className="text-sm font-bold" style={{ color: '#eab308' }}>${vastai.ratePerDay.toFixed(2)}</span>
                              ) : (
                                <span className="text-sm" style={{ color: 'var(--text-muted)' }}>N/A</span>
                              )}
                            </div>
                          </div>

                          {bestExternal && internal && (
                            <div className="pt-3 border-t border-border">
                              <div className="flex items-center justify-between text-sm">
                                <span style={{ color: 'var(--text-muted)' }}>Best External</span>
                                <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                                  ${bestExternal.toFixed(2)}/day
                                  <span className="ml-2" style={{ color: 'var(--text-muted)' }}>
                                    ({((bestExternal / internal.ratePerDay) * 100).toFixed(0)}% of retail)
                                  </span>
                                </span>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </FormSection>
            </FormCard>

            <FormCard title="Rate History" description="Track rate changes over time" icon={BarChart3}>
              <FormSection>
                <div className="flex items-center gap-4 flex-wrap">
                  <div>
                    <label className="text-xs block mb-2 font-medium" style={{ color: 'var(--text-muted)' }}>GPU Tier</label>
                    <div className="flex gap-2">
                      {GPU_TIER_ORDER.map((tier) => (
                        <button
                          key={tier}
                          onClick={() => setSelectedTier(tier)}
                          className={`px-3 py-2 text-sm rounded-lg font-medium transition-all ${
                            selectedTier === tier
                              ? 'bg-accent text-white'
                              : 'bg-surface hover:bg-surface-hover'
                          }`}
                          style={selectedTier === tier ? undefined : { color: 'var(--text-secondary)' }}
                        >
                          {tier}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="text-xs block mb-2 font-medium" style={{ color: 'var(--text-muted)' }}>Market</label>
                    <div className="flex gap-2">
                      {MARKETS.map((market) => (
                        <button
                          key={market}
                          onClick={() => setSelectedMarket(market)}
                          className={`px-4 py-2 text-sm rounded-lg font-medium transition-all ${
                            selectedMarket === market
                              ? MARKET_BUTTON_BG[market]
                              : 'bg-surface hover:bg-surface-hover'
                          }`}
                          style={selectedMarket === market ? undefined : { color: 'var(--text-secondary)' }}
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

                {historyLoading ? (
                  <div className="h-48 flex items-center justify-center">
                    <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading history...</p>
                  </div>
                ) : history.length === 0 ? (
                  <div className="h-48 flex items-center justify-center">
                    <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No rate history available for {selectedTier} on {selectedMarket}</p>
                  </div>
                ) : (
                  <div className="space-y-4">
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
                            <div key={i} className="flex-1 min-w-0 group relative">
                              <div
                                className={`w-full rounded-t transition-all ${barColor} group-hover:opacity-80`}
                                style={{ height: `${height}%`, minHeight: '4px' }}
                              />
                              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 bg-surface border border-border rounded-lg text-xs whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-10 pointer-events-none shadow-lg">
                                <p className="font-bold" style={{ color: 'var(--text-primary)' }}>${h.ratePerDay.toFixed(2)}/day</p>
                                <p style={{ color: 'var(--text-muted)' }}>{new Date(h.fetchedAt).toLocaleString()}</p>
                              </div>
                            </div>
                          )
                        })
                      })()}
                    </div>

                    <div className="grid grid-cols-4 gap-4">
                      <div className="p-4 bg-surface rounded-xl text-center">
                        <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Current</p>
                        <p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                          ${history[history.length - 1]?.ratePerDay.toFixed(2) ?? '-'}
                        </p>
                      </div>
                      <div className="p-4 bg-accent/5 border border-accent/20 rounded-xl text-center">
                        <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>High</p>
                        <p className="text-lg font-bold text-accent">
                          ${Math.max(...history.map(h => h.ratePerDay)).toFixed(2)}
                        </p>
                      </div>
                      <div className="p-4 bg-error/5 border border-error/20 rounded-xl text-center">
                        <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Low</p>
                        <p className="text-lg font-bold text-error">
                          ${Math.min(...history.map(h => h.ratePerDay)).toFixed(2)}
                        </p>
                      </div>
                      <div className="p-4 bg-surface rounded-xl text-center">
                        <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Average</p>
                        <p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                          ${(history.reduce((s, h) => s + h.ratePerDay, 0) / history.length).toFixed(2)}
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </FormSection>
            </FormCard>

            <FormCard title="Pricing Concepts" icon={Star}>
              <FormSection>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="flex gap-4">
                    <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center flex-shrink-0">
                      <Star className="w-5 h-5 text-accent" />
                    </div>
                    <div>
                      <h4 className="font-medium mb-1" style={{ color: 'var(--text-primary)' }}>Internal Rate</h4>
                      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Premium retail rate for TokenOS agent tasks with priority routing</p>
                    </div>
                  </div>
                  <div className="flex gap-4">
                    <div className="w-10 h-10 rounded-lg bg-accent-blue/10 flex items-center justify-center flex-shrink-0">
                      <Globe className="w-5 h-5 text-accent-blue" />
                    </div>
                    <div>
                      <h4 className="font-medium mb-1" style={{ color: 'var(--text-primary)' }}>External Rates</h4>
                      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Market rates from Akash and IO.net used when no internal demand</p>
                    </div>
                  </div>
                  <div className="flex gap-4">
                    <div className="w-10 h-10 rounded-lg bg-warning/10 flex items-center justify-center flex-shrink-0">
                      <Shield className="w-5 h-5 text-warning" />
                    </div>
                    <div>
                      <h4 className="font-medium mb-1" style={{ color: 'var(--text-primary)' }}>Yield Floor</h4>
                      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Minimum guaranteed rate. External rates below floor are boosted</p>
                    </div>
                  </div>
                </div>
              </FormSection>
            </FormCard>
          </>
        )}
      </div>
    </DashboardShell>
  )
}
