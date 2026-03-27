'use client'

import { useEffect, useState } from 'react'
import { Card, StatCard } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Tabs, TabList, Tab, TabPanel } from '@/components/ui/Tabs'
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

interface SystemHealth {
  status: string
  timestamp: string
  services: {
    database: { status: string; latencyMs: number }
    redis: { status: string; latencyMs: number; memoryUsage?: string }
    jobQueue: { status: string; waiting: number; active: number; completed: number; failed: number }
    rateFetcher: { status: string; lastRun: string | null; nextRun: string | null }
  }
  uptime: number
  version: string
}

interface PaymentModeInfo {
  mode: 'dev' | 'live'
  description: string
  devMode: boolean
  rpcConfigured: boolean
  payerConfigured: boolean
}

export default function SettingsPage() {
  const [floors, setFloors] = useState<YieldFloor[]>([])
  const [markets, setMarkets] = useState<MarketConfig[]>([])
  const [systemHealth, setSystemHealth] = useState<SystemHealth | null>(null)
  const [paymentMode, setPaymentMode] = useState<PaymentModeInfo | null>(null)
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
      const [floorsData, marketsData, healthData, paymentModeData] = await Promise.all([
        api.config.yieldFloors(),
        api.config.markets(),
        api.system.health().catch(() => null),
        api.payments.mode().catch(() => null),
      ])
      setFloors(floorsData?.floors ?? [])
      setMarkets(marketsData?.markets ?? [])
      setSystemHealth(healthData)
      setPaymentMode(paymentModeData)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings')
      setFloors([])
      setMarkets([])
    } finally {
      setLoading(false)
    }
  }

  function formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400)
    const hours = Math.floor((seconds % 86400) / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    if (days > 0) return `${days}d ${hours}h ${minutes}m`
    if (hours > 0) return `${hours}h ${minutes}m`
    return `${minutes}m`
  }

  function getStatusColor(status: string): string {
    switch (status.toLowerCase()) {
      case 'healthy':
      case 'connected':
      case 'running':
        return 'text-accent'
      case 'degraded':
      case 'warning':
        return 'text-warning'
      case 'unhealthy':
      case 'error':
      case 'disconnected':
        return 'text-error'
      default:
        return 'text-text-muted'
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Settings</h1>
          <p className="text-text-muted mt-1">
            Configure system settings and monitor health
          </p>
        </div>
        <Button onClick={loadSettings} variant="outline" size="sm">
          Refresh
        </Button>
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
        <Tabs defaultTab="routing">
          <TabList>
            <Tab value="routing">Routing Config</Tab>
            <Tab value="health">System Health</Tab>
            <Tab value="payment">Payment Config</Tab>
            <Tab value="audit">Audit Log</Tab>
          </TabList>

          {/* Routing Config Tab */}
          <TabPanel value="routing">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 pt-6">
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
          </TabPanel>

          {/* System Health Tab */}
          <TabPanel value="health">
            <div className="space-y-6 pt-6">
              {systemHealth ? (
                <>
                  {/* Health Overview */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <StatCard
                      label="System Status"
                      value={systemHealth.status}
                      className={systemHealth.status === 'healthy' ? 'border-accent/30' : 'border-warning/30'}
                    />
                    <StatCard
                      label="Uptime"
                      value={formatUptime(systemHealth.uptime)}
                    />
                    <StatCard
                      label="Version"
                      value={systemHealth.version || 'Unknown'}
                    />
                    <StatCard
                      label="Last Check"
                      value={new Date(systemHealth.timestamp).toLocaleTimeString()}
                    />
                  </div>

                  {/* Service Status */}
                  <Card title="Service Status" description="Real-time status of system components">
                    <div className="space-y-4 mt-4">
                      {/* Database */}
                      <div className="p-4 bg-background rounded-lg border border-border flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span className={`w-2 h-2 rounded-full ${systemHealth.services.database.status === 'connected' ? 'bg-accent' : 'bg-error'}`} />
                          <span className="font-medium text-text-primary">Database (PostgreSQL)</span>
                        </div>
                        <div className="text-right">
                          <span className={getStatusColor(systemHealth.services.database.status)}>
                            {systemHealth.services.database.status}
                          </span>
                          <span className="text-text-muted text-xs ml-2">
                            {systemHealth.services.database.latencyMs}ms
                          </span>
                        </div>
                      </div>

                      {/* Redis */}
                      <div className="p-4 bg-background rounded-lg border border-border flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span className={`w-2 h-2 rounded-full ${systemHealth.services.redis.status === 'connected' ? 'bg-accent' : 'bg-error'}`} />
                          <span className="font-medium text-text-primary">Redis Cache</span>
                        </div>
                        <div className="text-right">
                          <span className={getStatusColor(systemHealth.services.redis.status)}>
                            {systemHealth.services.redis.status}
                          </span>
                          <span className="text-text-muted text-xs ml-2">
                            {systemHealth.services.redis.latencyMs}ms
                          </span>
                          {systemHealth.services.redis.memoryUsage && (
                            <span className="text-text-muted text-xs ml-2">
                              ({systemHealth.services.redis.memoryUsage})
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Job Queue */}
                      <div className="p-4 bg-background rounded-lg border border-border">
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-3">
                            <span className={`w-2 h-2 rounded-full ${systemHealth.services.jobQueue.status === 'running' ? 'bg-accent' : 'bg-warning'}`} />
                            <span className="font-medium text-text-primary">Job Queue (BullMQ)</span>
                          </div>
                          <span className={getStatusColor(systemHealth.services.jobQueue.status)}>
                            {systemHealth.services.jobQueue.status}
                          </span>
                        </div>
                        <div className="grid grid-cols-4 gap-4 text-center">
                          <div>
                            <p className="text-lg font-bold text-warning">{systemHealth.services.jobQueue.waiting}</p>
                            <p className="text-xs text-text-muted">Waiting</p>
                          </div>
                          <div>
                            <p className="text-lg font-bold text-blue-400">{systemHealth.services.jobQueue.active}</p>
                            <p className="text-xs text-text-muted">Active</p>
                          </div>
                          <div>
                            <p className="text-lg font-bold text-accent">{systemHealth.services.jobQueue.completed}</p>
                            <p className="text-xs text-text-muted">Completed</p>
                          </div>
                          <div>
                            <p className="text-lg font-bold text-error">{systemHealth.services.jobQueue.failed}</p>
                            <p className="text-xs text-text-muted">Failed</p>
                          </div>
                        </div>
                      </div>

                      {/* Rate Fetcher */}
                      <div className="p-4 bg-background rounded-lg border border-border flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span className={`w-2 h-2 rounded-full ${systemHealth.services.rateFetcher.status === 'running' ? 'bg-accent' : 'bg-warning'}`} />
                          <span className="font-medium text-text-primary">Rate Fetcher</span>
                        </div>
                        <div className="text-right text-sm">
                          <span className={getStatusColor(systemHealth.services.rateFetcher.status)}>
                            {systemHealth.services.rateFetcher.status}
                          </span>
                          {systemHealth.services.rateFetcher.lastRun && (
                            <p className="text-xs text-text-muted">
                              Last: {new Date(systemHealth.services.rateFetcher.lastRun).toLocaleTimeString()}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  </Card>
                </>
              ) : (
                <Card className="p-8 text-center">
                  <p className="text-text-muted">Unable to fetch system health data</p>
                  <Button onClick={loadSettings} variant="outline" size="sm" className="mt-4">
                    Retry
                  </Button>
                </Card>
              )}
            </div>
          </TabPanel>

          {/* Payment Config Tab */}
          <TabPanel value="payment">
            <div className="space-y-6 pt-6">
              {paymentMode ? (
                <>
                  {/* Payment Mode Banner */}
                  <div className={`p-6 rounded-xl border ${
                    paymentMode.devMode
                      ? 'bg-warning/10 border-warning/30'
                      : 'bg-accent/10 border-accent/30'
                  }`}>
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="flex items-center gap-3 mb-2">
                          <span className={`px-4 py-1.5 rounded-full text-sm font-bold ${
                            paymentMode.devMode
                              ? 'bg-warning/20 text-warning'
                              : 'bg-accent/20 text-accent'
                          }`}>
                            {paymentMode.mode.toUpperCase()} MODE
                          </span>
                        </div>
                        <p className="text-text-secondary">{paymentMode.description}</p>
                      </div>
                    </div>
                  </div>

                  {/* Configuration Status */}
                  <Card title="Payment Configuration" description="Solana payment system status">
                    <div className="space-y-4 mt-4">
                      <div className="p-4 bg-background rounded-lg border border-border flex items-center justify-between">
                        <div>
                          <span className="font-medium text-text-primary">Solana RPC</span>
                          <p className="text-xs text-text-muted mt-1">Connection to Solana network</p>
                        </div>
                        <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                          paymentMode.rpcConfigured
                            ? 'bg-accent/10 text-accent'
                            : 'bg-warning/10 text-warning'
                        }`}>
                          {paymentMode.rpcConfigured ? 'Configured' : 'Not Configured'}
                        </span>
                      </div>

                      <div className="p-4 bg-background rounded-lg border border-border flex items-center justify-between">
                        <div>
                          <span className="font-medium text-text-primary">Payer Wallet</span>
                          <p className="text-xs text-text-muted mt-1">Wallet for sending payments</p>
                        </div>
                        <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                          paymentMode.payerConfigured
                            ? 'bg-accent/10 text-accent'
                            : 'bg-warning/10 text-warning'
                        }`}>
                          {paymentMode.payerConfigured ? 'Configured' : 'Not Configured'}
                        </span>
                      </div>

                      {paymentMode.devMode && (
                        <div className="p-4 bg-warning/10 border border-warning/20 rounded-lg">
                          <p className="text-sm text-warning">
                            <strong>Dev Mode Active:</strong> Payments are simulated. Configure Solana RPC and payer wallet to enable live payments.
                          </p>
                        </div>
                      )}
                    </div>
                  </Card>

                  {/* Payment Settings */}
                  <Card title="Payment Settings" description="Configure payment behavior">
                    <div className="space-y-4 mt-4">
                      <div className="p-4 bg-background rounded-lg border border-border">
                        <p className="text-sm text-text-muted mb-2">Supported Currencies</p>
                        <div className="flex gap-2">
                          <span className="px-3 py-1 bg-accent/10 text-accent text-sm rounded-lg">USDC</span>
                          <span className="px-3 py-1 bg-purple-500/10 text-purple-400 text-sm rounded-lg">SOL</span>
                        </div>
                      </div>
                      <div className="p-4 bg-background rounded-lg border border-border">
                        <p className="text-sm text-text-muted mb-2">Network</p>
                        <span className="text-text-primary font-medium">Solana Mainnet</span>
                      </div>
                    </div>
                  </Card>
                </>
              ) : (
                <Card className="p-8 text-center">
                  <p className="text-text-muted">Unable to fetch payment configuration</p>
                  <Button onClick={loadSettings} variant="outline" size="sm" className="mt-4">
                    Retry
                  </Button>
                </Card>
              )}
            </div>
          </TabPanel>

          {/* Audit Log Tab */}
          <TabPanel value="audit">
            <div className="pt-6">
              <AuditLog />
            </div>
          </TabPanel>
        </Tabs>
      )}
    </div>
  )
}
