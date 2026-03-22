'use client'

import { useEffect, useState } from 'react'
import { Card, StatCard } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { api } from '@/lib/api'

interface Rate {
  market: string
  gpuTier: string
  ratePerHour: number
  ratePerDay: number
  available: boolean
  enabled: boolean
  fetchedAt: string
}

const GPU_TIER_ORDER = ['H100', 'H200', 'B200', 'B300', 'GB300']

export default function RatesPage() {
  const [rates, setRates] = useState<Rate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)

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
    }
  })

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Market Rates</h1>
          <p className="text-text-muted mt-1">
            Current GPU pricing across all markets
          </p>
        </div>
        <div className="flex items-center gap-4">
          {lastUpdated && (
            <span className="text-sm text-text-muted">
              Updated: {new Date(lastUpdated).toLocaleTimeString()}
            </span>
          )}
          <Button onClick={loadRates} variant="secondary" size="sm">
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-error/10 border border-error/20 rounded-lg">
          <p className="text-error text-sm">{error}</p>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <p className="text-text-muted">Loading rates...</p>
        </div>
      ) : (
        <>
          {/* Rate Comparison Table */}
          <Card title="Rate Comparison by GPU Tier">
            <div className="overflow-x-auto mt-4">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-3 px-4 text-xs text-text-muted uppercase">GPU Tier</th>
                    <th className="text-right py-3 px-4 text-xs text-text-muted uppercase">
                      <span className="text-accent">Internal (Retail)</span>
                    </th>
                    <th className="text-right py-3 px-4 text-xs text-text-muted uppercase">
                      <span className="text-blue-400">Akash</span>
                    </th>
                    <th className="text-right py-3 px-4 text-xs text-text-muted uppercase">
                      <span className="text-purple-400">IO.net</span>
                    </th>
                    <th className="text-right py-3 px-4 text-xs text-text-muted uppercase">Best External</th>
                  </tr>
                </thead>
                <tbody>
                  {ratesByTier.map(({ tier, internal, akash, ionet }) => {
                    const externalRates = [
                      akash?.available ? akash.ratePerDay : 0,
                      ionet?.available ? ionet.ratePerDay : 0,
                    ].filter((r) => r > 0)
                    const bestExternal = externalRates.length > 0 ? Math.max(...externalRates) : null

                    return (
                      <tr key={tier} className="border-b border-border/50">
                        <td className="py-4 px-4">
                          <span className="font-medium text-text-primary">{tier}</span>
                        </td>
                        <td className="py-4 px-4 text-right">
                          <span className="text-accent font-bold">
                            ${internal?.ratePerDay.toFixed(2) ?? '-'}
                          </span>
                          <span className="text-text-muted text-xs">/day</span>
                        </td>
                        <td className="py-4 px-4 text-right">
                          {akash?.available ? (
                            <>
                              <span className="text-blue-400">${akash.ratePerDay.toFixed(2)}</span>
                              <span className="text-text-muted text-xs">/day</span>
                            </>
                          ) : (
                            <span className="text-text-muted">-</span>
                          )}
                        </td>
                        <td className="py-4 px-4 text-right">
                          {ionet?.available ? (
                            <>
                              <span className="text-purple-400">${ionet.ratePerDay.toFixed(2)}</span>
                              <span className="text-text-muted text-xs">/day</span>
                            </>
                          ) : (
                            <span className="text-text-muted">-</span>
                          )}
                        </td>
                        <td className="py-4 px-4 text-right">
                          {bestExternal ? (
                            <div>
                              <span className="text-text-primary font-medium">${bestExternal.toFixed(2)}</span>
                              <span className="text-text-muted text-xs">/day</span>
                              <p className="text-xs text-text-muted">
                                {internal && ((bestExternal / internal.ratePerDay) * 100).toFixed(0)}% of retail
                              </p>
                            </div>
                          ) : (
                            <span className="text-text-muted">No external</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Info */}
          <Card>
            <div className="text-sm text-text-muted space-y-2">
              <p><strong className="text-text-primary">Internal Rate:</strong> Premium retail rate for TokenOS agent tasks (priority routing)</p>
              <p><strong className="text-text-primary">External Rates:</strong> Market rates from Akash, IO.net (used when no internal demand)</p>
              <p><strong className="text-text-primary">Yield Floor:</strong> Minimum guaranteed rate — external rates below floor are boosted</p>
            </div>
          </Card>
        </>
      )}
    </div>
  )
}
