'use client'

import { useEffect, useState } from 'react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { api } from '@/lib/api'
import { AuditLog } from '@/components/config/AuditLog'

interface YieldFloor {
  gpuTier: string
  ratePerHour: number
  ratePerDay: number
  isCustom: boolean
  defaultFloor: number
}

interface MarketConfig {
  market: string
  enabled: boolean
  priority: number
}

export default function SettingsPage() {
  const [floors, setFloors] = useState<YieldFloor[]>([])
  const [markets, setMarkets] = useState<MarketConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [updating, setUpdating] = useState<string | null>(null)

  // Edit state
  const [editFloor, setEditFloor] = useState<{ tier: string; value: string } | null>(null)

  useEffect(() => {
    loadSettings()
  }, [])

  async function loadSettings() {
    try {
      const [floorsData, marketsData] = await Promise.all([
        api.config.yieldFloors(),
        api.config.markets(),
      ])
      setFloors(floorsData?.floors ?? [])
      setMarkets(marketsData?.markets ?? [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings')
      // Set empty arrays on error to prevent undefined errors
      setFloors([])
      setMarkets([])
    } finally {
      setLoading(false)
    }
  }

  async function handleUpdateFloor(gpuTier: string, ratePerDay: number) {
    setUpdating(gpuTier)
    setError(null)
    setSuccess(null)

    try {
      await api.config.updateYieldFloor({ gpuTier, ratePerDay })
      await loadSettings()
      setEditFloor(null)
      setSuccess(`Updated yield floor for ${gpuTier}`)
      setTimeout(() => setSuccess(null), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update floor')
    } finally {
      setUpdating(null)
    }
  }

  async function handleToggleMarket(market: string, enabled: boolean) {
    setUpdating(market)
    setError(null)
    setSuccess(null)

    try {
      await api.config.updateMarket({ market, enabled })
      await loadSettings()
      setSuccess(`${enabled ? 'Enabled' : 'Disabled'} ${market} market`)
      setTimeout(() => setSuccess(null), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update market')
    } finally {
      setUpdating(null)
    }
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Settings</h1>
        <p className="text-text-muted mt-1">
          Configure yield floors and market settings
        </p>
      </div>

      {error && (
        <div className="p-4 bg-error/10 border border-error/20 rounded-lg">
          <p className="text-error text-sm">{error}</p>
        </div>
      )}

      {success && (
        <div className="p-4 bg-accent/10 border border-accent/20 rounded-lg">
          <p className="text-accent text-sm">{success}</p>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <p className="text-text-muted">Loading settings...</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Yield Floors */}
          <Card title="Yield Floors" description="Minimum guaranteed rate per GPU tier">
            <div className="space-y-4 mt-4">
              {Array.isArray(floors) && floors.length > 0 ? floors.map((floor) => (
                <div
                  key={floor.gpuTier}
                  className="p-4 bg-background rounded-lg border border-border"
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-medium text-text-primary">{floor.gpuTier}</span>
                    {floor.isCustom && (
                      <span className="px-2 py-0.5 bg-accent/10 text-accent text-xs rounded">
                        Custom
                      </span>
                    )}
                  </div>

                  {editFloor?.tier === floor.gpuTier ? (
                    <div className="flex items-center gap-2 mt-3">
                      <Input
                        type="number"
                        value={editFloor.value}
                        onChange={(e) => setEditFloor({ tier: floor.gpuTier, value: e.target.value })}
                        className="flex-1"
                        placeholder="Rate per day"
                      />
                      <Button
                        size="sm"
                        loading={updating === floor.gpuTier}
                        onClick={() => handleUpdateFloor(floor.gpuTier, parseFloat(editFloor.value))}
                      >
                        Save
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditFloor(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-2xl font-bold text-accent">
                          ${floor.ratePerDay.toFixed(2)}
                          <span className="text-sm text-text-muted font-normal">/day</span>
                        </p>
                        <p className="text-xs text-text-muted">
                          Default: ${floor.defaultFloor}/day
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditFloor({ tier: floor.gpuTier, value: floor.ratePerDay.toString() })}
                      >
                        Edit
                      </Button>
                    </div>
                  )}
                </div>
              )) : (
                <p className="text-text-muted text-sm py-4 text-center">No yield floors configured</p>
              )}
            </div>
          </Card>

          {/* Market Configuration */}
          <Card title="Market Configuration" description="Enable or disable external markets">
            <div className="space-y-4 mt-4">
              {Array.isArray(markets) && markets.length > 0 ? markets.map((market) => (
                <div
                  key={market.market}
                  className="p-4 bg-background rounded-lg border border-border"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span className={`font-medium ${
                        market.market === 'INTERNAL' ? 'text-accent' :
                        market.market === 'AKASH' ? 'text-blue-400' : 'text-purple-400'
                      }`}>
                        {market.market}
                      </span>
                      {market.market === 'INTERNAL' && (
                        <p className="text-xs text-text-muted mt-1">Always enabled (premium rate)</p>
                      )}
                    </div>

                    {market.market !== 'INTERNAL' && (
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={market.enabled}
                          onChange={(e) => handleToggleMarket(market.market, e.target.checked)}
                          disabled={updating === market.market}
                          className="sr-only peer"
                        />
                        <div className="w-11 h-6 bg-border peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-text-muted after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent peer-checked:after:bg-background"></div>
                      </label>
                    )}

                    {market.market === 'INTERNAL' && (
                      <span className="px-3 py-1 bg-accent/10 text-accent text-xs rounded-full">
                        Always On
                      </span>
                    )}
                  </div>
                </div>
              )) : (
                <p className="text-text-muted text-sm py-4 text-center">No markets configured</p>
              )}
            </div>

            <div className="mt-6 p-4 bg-surface-hover rounded-lg">
              <p className="text-sm text-text-muted">
                <strong className="text-text-primary">Note:</strong> Disabling an external market means jobs won&apos;t be routed there even if it offers the best rate.
              </p>
            </div>
          </Card>
        </div>
      )}

      {/* Audit Log */}
      <AuditLog />
    </div>
  )
}
