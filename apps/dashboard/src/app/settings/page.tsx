'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Settings as LucideSettings, Database, Shield, Heart, Server, Clock, Tag, AlertTriangle, X, Check, Mail } from 'lucide-react'
import { Card, StatCard } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Tabs, TabList, Tab, TabPanel } from '@/components/ui/Tabs'
import { api } from '@/lib/api'
import { AuditLog } from '@/components/config/AuditLog'

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

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

interface SettlementConfig {
  period: string
  minimumPayout: number
  dayOfWeek: number | null
  dayOfMonth: number | null
  hour: number
  autoSchedule: boolean
  lastScheduledAt: string | null
}

interface FailedSettlement {
  id: string
  nodeId: string
  walletAddress: string
  amount: number
  status: string
  retryCount: number
  maxRetries: number
  nextRetryAt: string | null
  createdAt: string
}

export default function SettingsPage() {
  const [floors, setFloors] = useState<YieldFloor[]>([])
  const [markets, setMarkets] = useState<MarketConfig[]>([])
  const [systemHealth, setSystemHealth] = useState<SystemHealth | null>(null)
  const [paymentMode, setPaymentMode] = useState<PaymentModeInfo | null>(null)
  const [settlementConfig, setSettlementConfig] = useState<SettlementConfig | null>(null)
  const [failedSettlements, setFailedSettlements] = useState<{ retriable: FailedSettlement[]; exhausted: FailedSettlement[] }>({ retriable: [], exhausted: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [updating, setUpdating] = useState<string | null>(null)
  const [retrying, setRetrying] = useState<string | null>(null)

  // SMTP state
  const [smtpConfig, setSmtpConfig] = useState<{
    host: string
    port: number
    secure: boolean
    username: string
    password: string
    fromAddress: string
    configured: boolean
  }>({ host: '', port: 587, secure: true, username: '', password: '', fromAddress: '', configured: false })
  const [smtpLoading, setSmtpLoading] = useState(false)
  const [smtpSaving, setSmtpSaving] = useState(false)
  const [testEmail, setTestEmail] = useState('')
  const [testingSend, setTestingSend] = useState(false)

  // Edit state
  const [editFloor, setEditFloor] = useState<{ tier: string; value: string } | null>(null)

  useEffect(() => {
    loadSettings()
  }, [])

  async function loadSettings() {
    try {
      const [floorsData, marketsData, healthData, paymentModeData, settlementConfigData, failedData, smtpData] = await Promise.all([
        api.config.yieldFloors(),
        api.config.markets(),
        api.system.health().catch(() => null),
        api.payments.mode().catch(() => null),
        api.settlements.config().catch(() => null),
        api.settlements.failed().catch(() => ({ retriable: [], exhausted: [] })),
        api.smtp.get().catch(() => null),
      ])
      setFloors(floorsData?.floors ?? [])
      setMarkets(marketsData?.markets ?? [])
      setSystemHealth(healthData)
      setPaymentMode(paymentModeData)
      setSettlementConfig(settlementConfigData)
      setFailedSettlements(failedData)
      if (smtpData) {
        setSmtpConfig({
          host: smtpData.host || '',
          port: smtpData.port || 587,
          secure: smtpData.secure ?? true,
          username: smtpData.username || '',
          password: '',
          fromAddress: smtpData.fromAddress || '',
          configured: smtpData.configured ?? false,
        })
      }
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

  function getStatusDotColor(status: string): string {
    switch (status.toLowerCase()) {
      case 'healthy':
      case 'connected':
      case 'running':
        return 'bg-accent shadow-[0_0_8px_rgba(34,197,94,0.5)]'
      case 'degraded':
      case 'warning':
        return 'bg-warning shadow-[0_0_8px_rgba(245,158,11,0.5)]'
      case 'unhealthy':
      case 'error':
      case 'disconnected':
        return 'bg-error shadow-[0_0_8px_rgba(239,68,68,0.5)]'
      default:
        return 'bg-text-muted'
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

  async function handleToggleAutoSchedule(enabled: boolean) {
    setUpdating('autoSchedule')
    setError(null)
    setSuccess(null)

    try {
      await api.settlements.updateConfig({ autoSchedule: enabled })
      await loadSettings()
      setSuccess(`Auto-scheduling ${enabled ? 'enabled' : 'disabled'}`)
      setTimeout(() => setSuccess(null), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update auto-schedule')
    } finally {
      setUpdating(null)
    }
  }

  async function handleUpdateScheduleHour(hour: number) {
    setUpdating('hour')
    setError(null)
    setSuccess(null)

    try {
      await api.settlements.updateConfig({ hour })
      await loadSettings()
      setSuccess(`Schedule hour updated to ${hour}:00`)
      setTimeout(() => setSuccess(null), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update schedule hour')
    } finally {
      setUpdating(null)
    }
  }

  async function handleRetrySettlement(id: string) {
    setRetrying(id)
    setError(null)
    setSuccess(null)

    try {
      await api.settlements.retry(id)
      await loadSettings()
      setSuccess('Settlement queued for retry')
      setTimeout(() => setSuccess(null), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to retry settlement')
    } finally {
      setRetrying(null)
    }
  }

  async function handleSaveSmtp() {
    setSmtpSaving(true)
    setError(null)
    setSuccess(null)

    try {
      const payload: Record<string, unknown> = {
        host: smtpConfig.host,
        port: smtpConfig.port,
        secure: smtpConfig.secure,
        username: smtpConfig.username,
        fromAddress: smtpConfig.fromAddress,
      }
      if (smtpConfig.password) {
        payload.password = smtpConfig.password
      }
      await api.smtp.update(payload as Parameters<typeof api.smtp.update>[0])
      setSmtpConfig(prev => ({ ...prev, password: '', configured: true }))
      setSuccess('SMTP settings saved successfully')
      setTimeout(() => setSuccess(null), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save SMTP settings')
    } finally {
      setSmtpSaving(false)
    }
  }

  async function handleTestEmail() {
    if (!testEmail) return
    setTestingSend(true)
    setError(null)
    setSuccess(null)

    try {
      await api.smtp.test(testEmail)
      setSuccess(`Test email sent to ${testEmail}`)
      setTimeout(() => setSuccess(null), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send test email')
    } finally {
      setTestingSend(false)
    }
  }

  // Count healthy services
  const healthyServices = systemHealth ?
    Object.values(systemHealth.services).filter(s =>
      ['connected', 'running', 'healthy'].includes((s as { status: string }).status.toLowerCase())
    ).length : 0
  const totalServices = systemHealth ? Object.keys(systemHealth.services).length : 0

  return (
    <motion.div variants={container} initial="hidden" animate="show" className="dashboard-modern">
      {/* Header */}
      <motion.div className="dash-header" variants={item}>
        <div className="dash-header-left">
          <h1><LucideSettings size={28} /> Settings</h1>
        </div>
        <div className="dash-header-right" />
      </motion.div>

      {/* Alerts */}
      {error && (
        <div className="p-4 bg-error/10 border border-error/20 rounded-xl flex items-center gap-3 animate-slideUp">
          <div className="w-8 h-8 rounded-lg bg-error/20 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-4 h-4 text-error" />
          </div>
          <p className="text-error text-sm">{error}</p>
          <button onClick={() => setError(null)} className="ml-auto text-error/60 hover:text-error">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {success && (
        <div className="p-4 bg-accent/10 border border-accent/20 rounded-xl flex items-center gap-3 animate-slideUp">
          <div className="w-8 h-8 rounded-lg bg-accent/20 flex items-center justify-center shrink-0">
            <Check className="w-4 h-4 text-accent" />
          </div>
          <p className="text-accent text-sm">{success}</p>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="flex flex-col items-center gap-3">
            <div className="w-10 h-10 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            <p className="text-text-muted">Loading settings...</p>
          </div>
        </div>
      ) : (
        <Tabs defaultTab="routing">
          <TabList>
            <Tab value="routing">Routing Config</Tab>
            <Tab value="settlements">Settlements</Tab>
            <Tab value="health">System Health</Tab>
            <Tab value="payment">Payment Config</Tab>
            <Tab value="email">Email / SMTP</Tab>
            <Tab value="audit">Audit Log</Tab>
          </TabList>

          {/* Routing Config Tab */}
          <TabPanel value="routing">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 pt-6">
              {/* Yield Floors */}
              <Card variant="glass" hover={false}>
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent to-emerald-400 flex items-center justify-center">
                    <DollarIcon className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-text-primary">Yield Floors</h3>
                    <p className="text-xs text-text-muted">Minimum guaranteed rate per GPU tier</p>
                  </div>
                </div>

                <div className="space-y-3">
                  {Array.isArray(floors) && floors.length > 0 ? floors.map((floor) => (
                    <div
                      key={floor.gpuTier}
                      className="p-4 bg-background/50 rounded-xl border border-border/50 hover:border-accent/30 transition-colors"
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-medium text-text-primary">{floor.gpuTier}</span>
                        {floor.isCustom && (
                          <span className="px-2 py-0.5 bg-accent/10 text-accent text-xs rounded-full">
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
                    <div className="py-8 text-center">
                      <div className="w-12 h-12 rounded-xl bg-surface-hover flex items-center justify-center mx-auto mb-3">
                        <DollarIcon className="w-6 h-6 text-text-muted" />
                      </div>
                      <p className="text-text-muted text-sm">No yield floors configured</p>
                    </div>
                  )}
                </div>
              </Card>

              {/* Market Configuration */}
              <Card variant="glass" hover={false}>
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-blue-400 flex items-center justify-center">
                    <RouteIcon className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-text-primary">Market Configuration</h3>
                    <p className="text-xs text-text-muted">Enable or disable external markets</p>
                  </div>
                </div>

                <div className="space-y-3">
                  {Array.isArray(markets) && markets.length > 0 ? markets.map((market) => (
                    <div
                      key={market.market}
                      className="p-4 bg-background/50 rounded-xl border border-border/50 hover:border-accent/30 transition-colors"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div
                            className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                              market.market === 'INTERNAL' ? 'bg-accent/20' :
                              market.market === 'AKASH' ? 'bg-blue-500/20' :
                              market.market === 'IONET' ? 'bg-purple-500/20' : ''
                            }`}
                            style={market.market === 'VASTAI' ? { background: 'rgba(234,179,8,0.18)' } : undefined}
                          >
                            <span
                              className={`text-sm font-bold ${
                                market.market === 'INTERNAL' ? 'text-accent' :
                                market.market === 'AKASH' ? 'text-blue-400' :
                                market.market === 'IONET' ? 'text-purple-400' : ''
                              }`}
                              style={market.market === 'VASTAI' ? { color: '#eab308' } : undefined}
                            >
                              {market.market.charAt(0)}
                            </span>
                          </div>
                          <div>
                            <span
                              className={`font-medium ${
                                market.market === 'INTERNAL' ? 'text-accent' :
                                market.market === 'AKASH' ? 'text-blue-400' :
                                market.market === 'IONET' ? 'text-purple-400' : ''
                              }`}
                              style={market.market === 'VASTAI' ? { color: '#eab308' } : undefined}
                            >
                              {market.market === 'VASTAI' ? 'VAST.AI' : market.market}
                            </span>
                            {market.market === 'INTERNAL' && (
                              <p className="text-xs text-text-muted">Always enabled (premium rate)</p>
                            )}
                          </div>
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
                          <span className="px-3 py-1 bg-accent/10 text-accent text-xs rounded-full font-medium">
                            Always On
                          </span>
                        )}
                      </div>
                    </div>
                  )) : (
                    <div className="py-8 text-center">
                      <div className="w-12 h-12 rounded-xl bg-surface-hover flex items-center justify-center mx-auto mb-3">
                        <RouteIcon className="w-6 h-6 text-text-muted" />
                      </div>
                      <p className="text-text-muted text-sm">No markets configured</p>
                    </div>
                  )}
                </div>

                <div className="mt-6 p-4 bg-accent/5 border border-accent/20 rounded-xl">
                  <p className="text-sm text-text-secondary">
                    <strong className="text-accent">Note:</strong> Disabling an external market means jobs won&apos;t be routed there even if it offers the best rate.
                  </p>
                </div>
              </Card>
            </div>
          </TabPanel>

          {/* Settlements Tab */}
          <TabPanel value="settlements">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 pt-6">
              {/* Auto-Schedule Config */}
              <Card variant="glass" hover={false}>
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-purple-400 flex items-center justify-center">
                    <CalendarIcon className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-text-primary">Auto-Schedule</h3>
                    <p className="text-xs text-text-muted">Automatic settlement scheduling</p>
                  </div>
                </div>

                {settlementConfig ? (
                  <div className="space-y-4">
                    {/* Auto-Schedule Toggle */}
                    <div className="p-4 bg-background/50 rounded-xl border border-border/50">
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="font-medium text-text-primary">Enable Auto-Scheduling</span>
                          <p className="text-xs text-text-muted mt-1">
                            Automatically run settlements based on period
                          </p>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={settlementConfig.autoSchedule}
                            onChange={(e) => handleToggleAutoSchedule(e.target.checked)}
                            disabled={updating === 'autoSchedule'}
                            className="sr-only peer"
                          />
                          <div className="w-11 h-6 bg-border peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-text-muted after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent peer-checked:after:bg-background"></div>
                        </label>
                      </div>
                    </div>

                    {/* Schedule Details */}
                    <div className="p-4 bg-background/50 rounded-xl border border-border/50 space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-text-muted">Period</span>
                        <span className="px-3 py-1 bg-accent/10 text-accent text-sm rounded-full font-medium">
                          {settlementConfig.period.toUpperCase()}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-text-muted">Schedule Hour</span>
                        <select
                          value={settlementConfig.hour}
                          onChange={(e) => handleUpdateScheduleHour(parseInt(e.target.value))}
                          disabled={updating === 'hour'}
                          className="px-3 py-1.5 bg-surface border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent"
                        >
                          {Array.from({ length: 24 }, (_, i) => (
                            <option key={i} value={i}>
                              {i.toString().padStart(2, '0')}:00
                            </option>
                          ))}
                        </select>
                      </div>
                      {settlementConfig.period === 'weekly' && settlementConfig.dayOfWeek !== null && (
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-text-muted">Day of Week</span>
                          <span className="text-text-primary font-medium">
                            {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][settlementConfig.dayOfWeek]}
                          </span>
                        </div>
                      )}
                      {settlementConfig.period === 'monthly' && settlementConfig.dayOfMonth !== null && (
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-text-muted">Day of Month</span>
                          <span className="text-text-primary font-medium">{settlementConfig.dayOfMonth}</span>
                        </div>
                      )}
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-text-muted">Last Scheduled</span>
                        <span className="text-text-primary text-sm">
                          {settlementConfig.lastScheduledAt
                            ? new Date(settlementConfig.lastScheduledAt).toLocaleString()
                            : 'Never'}
                        </span>
                      </div>
                    </div>

                    {settlementConfig.autoSchedule && (
                      <div className="p-4 bg-accent/5 border border-accent/20 rounded-xl flex items-center gap-3">
                        <CheckIcon className="w-5 h-5 text-accent shrink-0" />
                        <p className="text-sm text-text-secondary">
                          Settlements will automatically run {settlementConfig.period.toLowerCase()} at {settlementConfig.hour.toString().padStart(2, '0')}:00
                        </p>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="py-8 text-center">
                    <div className="w-12 h-12 rounded-xl bg-surface-hover flex items-center justify-center mx-auto mb-3">
                      <CalendarIcon className="w-6 h-6 text-text-muted" />
                    </div>
                    <p className="text-text-muted text-sm">Unable to load settlement config</p>
                    <Button onClick={loadSettings} variant="outline" size="sm" className="mt-3">
                      Retry
                    </Button>
                  </div>
                )}
              </Card>

              {/* Failed Settlements */}
              <Card variant="glass" hover={false}>
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-error to-red-400 flex items-center justify-center">
                    <AlertIcon className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-text-primary">Failed Settlements</h3>
                    <p className="text-xs text-text-muted">Settlements that need attention</p>
                  </div>
                </div>

                <div className="space-y-4">
                  {/* Retriable */}
                  {failedSettlements.retriable.length > 0 ? (
                    <div className="space-y-3">
                      <p className="text-sm text-text-muted">Retriable ({failedSettlements.retriable.length})</p>
                      {failedSettlements.retriable.map((s) => (
                        <div
                          key={s.id}
                          className="p-4 bg-background/50 rounded-xl border border-warning/30"
                        >
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-text-primary font-medium font-mono text-sm">
                              {s.walletAddress.slice(0, 8)}...{s.walletAddress.slice(-4)}
                            </span>
                            <span className="text-accent font-bold">${s.amount.toFixed(2)}</span>
                          </div>
                          <div className="flex items-center justify-between text-xs text-text-muted mb-3">
                            <span>Retry {s.retryCount}/{s.maxRetries}</span>
                            {s.nextRetryAt && (
                              <span>Next: {new Date(s.nextRetryAt).toLocaleTimeString()}</span>
                            )}
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            className="w-full"
                            loading={retrying === s.id}
                            onClick={() => handleRetrySettlement(s.id)}
                          >
                            Retry Now
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {/* Exhausted */}
                  {failedSettlements.exhausted.length > 0 && (
                    <div className="space-y-3">
                      <p className="text-sm text-text-muted">Exhausted Retries ({failedSettlements.exhausted.length})</p>
                      {failedSettlements.exhausted.map((s) => (
                        <div
                          key={s.id}
                          className="p-4 bg-background/50 rounded-xl border border-error/30"
                        >
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-text-primary font-medium font-mono text-sm">
                              {s.walletAddress.slice(0, 8)}...{s.walletAddress.slice(-4)}
                            </span>
                            <span className="text-error font-bold">${s.amount.toFixed(2)}</span>
                          </div>
                          <div className="flex items-center justify-between text-xs text-text-muted mb-3">
                            <span>Retried {s.retryCount} times</span>
                            <span className="text-error">Max retries exhausted</span>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            className="w-full border-error/30 text-error hover:bg-error/10"
                            loading={retrying === s.id}
                            onClick={() => handleRetrySettlement(s.id)}
                          >
                            Force Retry
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}

                  {failedSettlements.retriable.length === 0 && failedSettlements.exhausted.length === 0 && (
                    <div className="py-8 text-center">
                      <div className="w-12 h-12 rounded-xl bg-accent/10 flex items-center justify-center mx-auto mb-3">
                        <CheckIcon className="w-6 h-6 text-accent" />
                      </div>
                      <p className="text-accent text-sm font-medium">All settlements healthy</p>
                      <p className="text-text-muted text-xs mt-1">No failed settlements</p>
                    </div>
                  )}
                </div>
              </Card>
            </div>
          </TabPanel>

          {/* System Health Tab */}
          <TabPanel value="health">
            <div className="space-y-6 pt-6">
              {systemHealth ? (
                <>
                  {/* Service Status */}
                  <Card variant="glass" hover={false}>
                    <div className="flex items-center gap-3 mb-6">
                      <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-cyan-400 flex items-center justify-center">
                        <ServerIcon className="w-5 h-5 text-white" />
                      </div>
                      <div>
                        <h3 className="font-semibold text-text-primary">Service Status</h3>
                        <p className="text-xs text-text-muted">Real-time status of system components</p>
                      </div>
                    </div>

                    <div className="space-y-3">
                      {/* Database */}
                      <div className="p-4 bg-background/50 rounded-xl border border-border/50 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span className={`w-2.5 h-2.5 rounded-full ${getStatusDotColor(systemHealth.services.database.status)}`} />
                          <span className="font-medium text-text-primary">Database (PostgreSQL)</span>
                        </div>
                        <div className="text-right flex items-center gap-3">
                          <span className={`text-sm font-medium ${getStatusColor(systemHealth.services.database.status)}`}>
                            {systemHealth.services.database.status}
                          </span>
                          <span className="text-xs text-text-muted px-2 py-1 bg-surface-hover rounded-lg">
                            {systemHealth.services.database.latencyMs}ms
                          </span>
                        </div>
                      </div>

                      {/* Redis */}
                      <div className="p-4 bg-background/50 rounded-xl border border-border/50 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span className={`w-2.5 h-2.5 rounded-full ${getStatusDotColor(systemHealth.services.redis.status)}`} />
                          <span className="font-medium text-text-primary">Redis Cache</span>
                        </div>
                        <div className="text-right flex items-center gap-3">
                          <span className={`text-sm font-medium ${getStatusColor(systemHealth.services.redis.status)}`}>
                            {systemHealth.services.redis.status}
                          </span>
                          <span className="text-xs text-text-muted px-2 py-1 bg-surface-hover rounded-lg">
                            {systemHealth.services.redis.latencyMs}ms
                          </span>
                          {systemHealth.services.redis.memoryUsage && (
                            <span className="text-xs text-text-muted px-2 py-1 bg-surface-hover rounded-lg">
                              {systemHealth.services.redis.memoryUsage}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Job Queue */}
                      <div className="p-4 bg-background/50 rounded-xl border border-border/50">
                        <div className="flex items-center justify-between mb-4">
                          <div className="flex items-center gap-3">
                            <span className={`w-2.5 h-2.5 rounded-full ${getStatusDotColor(systemHealth.services.jobQueue.status)}`} />
                            <span className="font-medium text-text-primary">Job Queue (BullMQ)</span>
                          </div>
                          <span className={`text-sm font-medium ${getStatusColor(systemHealth.services.jobQueue.status)}`}>
                            {systemHealth.services.jobQueue.status}
                          </span>
                        </div>
                        <div className="grid grid-cols-4 gap-4">
                          <div className="text-center p-3 bg-warning/5 rounded-lg border border-warning/20">
                            <p className="text-xl font-bold text-warning">{systemHealth.services.jobQueue.waiting}</p>
                            <p className="text-xs text-text-muted">Waiting</p>
                          </div>
                          <div className="text-center p-3 bg-blue-500/5 rounded-lg border border-blue-500/20">
                            <p className="text-xl font-bold text-blue-400">{systemHealth.services.jobQueue.active}</p>
                            <p className="text-xs text-text-muted">Active</p>
                          </div>
                          <div className="text-center p-3 bg-accent/5 rounded-lg border border-accent/20">
                            <p className="text-xl font-bold text-accent">{systemHealth.services.jobQueue.completed}</p>
                            <p className="text-xs text-text-muted">Completed</p>
                          </div>
                          <div className="text-center p-3 bg-error/5 rounded-lg border border-error/20">
                            <p className="text-xl font-bold text-error">{systemHealth.services.jobQueue.failed}</p>
                            <p className="text-xs text-text-muted">Failed</p>
                          </div>
                        </div>
                      </div>

                      {/* Rate Fetcher */}
                      <div className="p-4 bg-background/50 rounded-xl border border-border/50 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span className={`w-2.5 h-2.5 rounded-full ${getStatusDotColor(systemHealth.services.rateFetcher.status)}`} />
                          <span className="font-medium text-text-primary">Rate Fetcher</span>
                        </div>
                        <div className="text-right">
                          <span className={`text-sm font-medium ${getStatusColor(systemHealth.services.rateFetcher.status)}`}>
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
                <Card variant="glass" className="p-12 text-center">
                  <div className="w-16 h-16 rounded-2xl bg-surface-hover flex items-center justify-center mx-auto mb-4">
                    <ServerIcon className="w-8 h-8 text-text-muted" />
                  </div>
                  <p className="text-text-muted mb-4">Unable to fetch system health data</p>
                  <Button onClick={loadSettings} variant="outline" size="sm">
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
                  <div className={`p-6 rounded-2xl border ${
                    paymentMode.devMode
                      ? 'bg-gradient-to-r from-warning/10 to-orange-500/5 border-warning/30'
                      : 'bg-gradient-to-r from-accent/10 to-emerald-500/5 border-accent/30'
                  }`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${
                          paymentMode.devMode ? 'bg-warning/20' : 'bg-accent/20'
                        }`}>
                          {paymentMode.devMode ? (
                            <CodeIcon className="w-6 h-6 text-warning" />
                          ) : (
                            <CreditCardIcon className="w-6 h-6 text-accent" />
                          )}
                        </div>
                        <div>
                          <div className="flex items-center gap-3 mb-1">
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
                  </div>

                  {/* Configuration Status */}
                  <Card variant="glass" hover={false}>
                    <div className="flex items-center gap-3 mb-6">
                      <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-purple-400 flex items-center justify-center">
                        <WalletIcon className="w-5 h-5 text-white" />
                      </div>
                      <div>
                        <h3 className="font-semibold text-text-primary">Payment Configuration</h3>
                        <p className="text-xs text-text-muted">Solana payment system status</p>
                      </div>
                    </div>

                    <div className="space-y-3">
                      <div className="p-4 bg-background/50 rounded-xl border border-border/50 flex items-center justify-between">
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

                      <div className="p-4 bg-background/50 rounded-xl border border-border/50 flex items-center justify-between">
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
                        <div className="p-4 bg-warning/5 border border-warning/20 rounded-xl flex items-center gap-3">
                          <AlertIcon className="w-5 h-5 text-warning shrink-0" />
                          <p className="text-sm text-warning">
                            <strong>Dev Mode Active:</strong> Payments are simulated. Configure Solana RPC and payer wallet to enable live payments.
                          </p>
                        </div>
                      )}
                    </div>
                  </Card>

                  {/* Payment Settings */}
                  <Card variant="glass" hover={false}>
                    <div className="flex items-center gap-3 mb-6">
                      <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-400 flex items-center justify-center">
                        <CurrencyIcon className="w-5 h-5 text-white" />
                      </div>
                      <div>
                        <h3 className="font-semibold text-text-primary">Payment Settings</h3>
                        <p className="text-xs text-text-muted">Configure payment behavior</p>
                      </div>
                    </div>

                    <div className="space-y-3">
                      <div className="p-4 bg-background/50 rounded-xl border border-border/50">
                        <p className="text-sm text-text-muted mb-3">Supported Currencies</p>
                        <div className="flex gap-2">
                          <span className="px-4 py-2 bg-accent/10 text-accent text-sm rounded-lg font-medium flex items-center gap-2">
                            <span className="w-5 h-5 rounded-full bg-accent/20 flex items-center justify-center text-xs">$</span>
                            USDC
                          </span>
                          <span className="px-4 py-2 bg-purple-500/10 text-purple-400 text-sm rounded-lg font-medium flex items-center gap-2">
                            <span className="w-5 h-5 rounded-full bg-purple-500/20 flex items-center justify-center text-xs">S</span>
                            SOL
                          </span>
                        </div>
                      </div>
                      <div className="p-4 bg-background/50 rounded-xl border border-border/50 flex items-center justify-between">
                        <span className="text-sm text-text-muted">Network</span>
                        <span className="text-text-primary font-medium">Solana Mainnet</span>
                      </div>
                    </div>
                  </Card>
                </>
              ) : (
                <Card variant="glass" className="p-12 text-center">
                  <div className="w-16 h-16 rounded-2xl bg-surface-hover flex items-center justify-center mx-auto mb-4">
                    <WalletIcon className="w-8 h-8 text-text-muted" />
                  </div>
                  <p className="text-text-muted mb-4">Unable to fetch payment configuration</p>
                  <Button onClick={loadSettings} variant="outline" size="sm">
                    Retry
                  </Button>
                </Card>
              )}
            </div>
          </TabPanel>

          {/* Email / SMTP Tab */}
          <TabPanel value="email">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 pt-6">
              {/* SMTP Configuration */}
              <Card variant="glass" hover={false}>
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-cyan-400 flex items-center justify-center">
                    <Mail className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-text-primary">SMTP Configuration</h3>
                    <p className="text-xs text-text-muted">Configure email delivery settings</p>
                  </div>
                  <span className={`ml-auto px-3 py-1 rounded-full text-xs font-medium ${
                    smtpConfig.configured
                      ? 'bg-accent/10 text-accent'
                      : 'bg-warning/10 text-warning'
                  }`}>
                    {smtpConfig.configured ? 'Configured' : 'Not Configured'}
                  </span>
                </div>

                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <Input
                      label="SMTP Host"
                      placeholder="smtp.example.com"
                      value={smtpConfig.host}
                      onChange={(e) => setSmtpConfig(prev => ({ ...prev, host: e.target.value }))}
                    />
                    <Input
                      label="SMTP Port"
                      type="number"
                      placeholder="587"
                      value={smtpConfig.port.toString()}
                      onChange={(e) => setSmtpConfig(prev => ({ ...prev, port: parseInt(e.target.value) || 587 }))}
                    />
                  </div>

                  <div className="p-4 bg-background/50 rounded-xl border border-border/50 flex items-center justify-between">
                    <div>
                      <span className="font-medium text-text-primary text-sm">Secure Connection (TLS)</span>
                      <p className="text-xs text-text-muted mt-0.5">Enable TLS encryption for email transport</p>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={smtpConfig.secure}
                        onChange={(e) => setSmtpConfig(prev => ({ ...prev, secure: e.target.checked }))}
                        className="sr-only peer"
                      />
                      <div className="w-11 h-6 bg-border peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-text-muted after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent peer-checked:after:bg-background"></div>
                    </label>
                  </div>

                  <Input
                    label="SMTP Username"
                    placeholder="your-username or email"
                    value={smtpConfig.username}
                    onChange={(e) => setSmtpConfig(prev => ({ ...prev, username: e.target.value }))}
                  />

                  <Input
                    label="SMTP Password"
                    type="password"
                    placeholder={smtpConfig.configured ? '(unchanged)' : 'Enter SMTP password'}
                    value={smtpConfig.password}
                    onChange={(e) => setSmtpConfig(prev => ({ ...prev, password: e.target.value }))}
                  />

                  <Input
                    label="From Address"
                    placeholder='A2E Engine <noreply@tokenos.ai>'
                    value={smtpConfig.fromAddress}
                    onChange={(e) => setSmtpConfig(prev => ({ ...prev, fromAddress: e.target.value }))}
                  />

                  <Button
                    onClick={handleSaveSmtp}
                    loading={smtpSaving}
                    className="w-full"
                  >
                    Save SMTP Settings
                  </Button>
                </div>
              </Card>

              {/* Test Email */}
              <Card variant="glass" hover={false}>
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-purple-400 flex items-center justify-center">
                    <SendIcon className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-text-primary">Send Test Email</h3>
                    <p className="text-xs text-text-muted">Verify your SMTP configuration works</p>
                  </div>
                </div>

                <div className="space-y-4">
                  {!smtpConfig.configured && (
                    <div className="p-4 bg-warning/5 border border-warning/20 rounded-xl flex items-center gap-3">
                      <AlertIcon className="w-5 h-5 text-warning shrink-0" />
                      <p className="text-sm text-warning">
                        Configure and save SMTP settings before sending a test email.
                      </p>
                    </div>
                  )}

                  <Input
                    label="Recipient Email"
                    type="email"
                    placeholder="test@example.com"
                    value={testEmail}
                    onChange={(e) => setTestEmail(e.target.value)}
                  />

                  <Button
                    onClick={handleTestEmail}
                    loading={testingSend}
                    variant="outline"
                    className="w-full"
                    disabled={!smtpConfig.configured || !testEmail}
                  >
                    Send Test Email
                  </Button>

                  <div className="p-4 bg-accent/5 border border-accent/20 rounded-xl">
                    <p className="text-sm text-text-secondary">
                      <strong className="text-accent">Tip:</strong> The test email will be sent from the configured &quot;From Address&quot; using the saved SMTP credentials.
                    </p>
                  </div>
                </div>
              </Card>
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
    </motion.div>
  )
}

// =============================================================================
// ICONS
// =============================================================================

function SettingsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
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

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  )
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  )
}

function HeartIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
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

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function TagIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
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

function RouteIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
    </svg>
  )
}

function WalletIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
    </svg>
  )
}

function CodeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
    </svg>
  )
}

function CreditCardIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
    </svg>
  )
}

function CurrencyIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
    </svg>
  )
}

function CalendarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  )
}

function SendIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  )
}
