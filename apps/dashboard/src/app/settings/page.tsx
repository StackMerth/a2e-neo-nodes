'use client'

import { useEffect, useState } from 'react'
import { AlertTriangle, X, Check, Mail, DollarSign, Route, Calendar, Server, CreditCard, Wallet, Send, Tag, Settings as SettingsIcon } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { api } from '@/lib/api'
import { AuditLog } from '@/components/config/AuditLog'
import {
  DashboardShell,
  FormCard,
  FormSection,
} from '@/components/dashboard/FuturisticShell'

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

type Tab = 'routing' | 'settlements' | 'health' | 'payment' | 'email' | 'audit'

const TABS: { id: Tab; label: string }[] = [
  { id: 'routing', label: 'Routing Config' },
  { id: 'settlements', label: 'Settlements' },
  { id: 'health', label: 'System Health' },
  { id: 'payment', label: 'Payment Config' },
  { id: 'email', label: 'Email / SMTP' },
  { id: 'audit', label: 'Audit Log' },
]

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<Tab>('routing')
  const [floors, setFloors] = useState<YieldFloor[]>([])
  const [markets, setMarkets] = useState<MarketConfig[]>([])
  const [systemHealth, setSystemHealth] = useState<SystemHealth | null>(null)
  const [paymentMode, setPaymentMode] = useState<PaymentModeInfo | null>(null)
  const [settlementConfig, setSettlementConfig] = useState<SettlementConfig | null>(null)
  const [failedSettlements, setFailedSettlements] = useState<{ retriable: FailedSettlement[]; exhausted: FailedSettlement[] }>({ retriable: [], exhausted: [] })
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [updating, setUpdating] = useState<string | null>(null)
  const [retrying, setRetrying] = useState<string | null>(null)

  const [smtpConfig, setSmtpConfig] = useState<{
    host: string
    port: number
    secure: boolean
    username: string
    password: string
    fromAddress: string
    configured: boolean
  }>({ host: '', port: 587, secure: true, username: '', password: '', fromAddress: '', configured: false })
  const [smtpSaving, setSmtpSaving] = useState(false)
  const [testEmail, setTestEmail] = useState('')
  const [testingSend, setTestingSend] = useState(false)

  const [editFloor, setEditFloor] = useState<{ tier: string; value: string } | null>(null)

  useEffect(() => {
    loadSettings()
  }, [])

  async function loadSettings(isRefresh = false) {
    if (isRefresh) setRefreshing(true)
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
      setRefreshing(false)
    }
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

  return (
    <DashboardShell
      title="Settings"
      subtitle="Configure routing, payments, and integrations"
      onRefresh={() => loadSettings(true)}
      refreshing={refreshing}
    >
      <div className="lg:col-span-3 max-w-5xl mx-auto w-full space-y-6">
        {/* Tab strip */}
        <div className="flex gap-1 p-1 bg-surface rounded-xl overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-all whitespace-nowrap ${
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

        {error && (
          <div className="p-4 bg-error/10 border border-error/20 rounded-xl flex items-center gap-3">
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
          <div className="p-4 bg-accent/10 border border-accent/20 rounded-xl flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-accent/20 flex items-center justify-center shrink-0">
              <Check className="w-4 h-4 text-accent" />
            </div>
            <p className="text-accent text-sm">{success}</p>
          </div>
        )}

        {loading ? null : (
          <>
            {activeTab === 'routing' && (
              <>
                <FormCard title="Yield Floors" description="Minimum guaranteed rate per GPU tier" icon={DollarSign}>
                  <FormSection>
                    <div className="space-y-3">
                      {Array.isArray(floors) && floors.length > 0 ? floors.map((floor) => (
                        <div key={floor.gpuTier} className="p-4 bg-background/50 rounded-xl border border-border/50 hover:border-accent/30 transition-colors">
                          <div className="flex items-center justify-between mb-2">
                            <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{floor.gpuTier}</span>
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
                              <Button size="sm" loading={updating === floor.gpuTier} onClick={() => handleUpdateFloor(floor.gpuTier, parseFloat(editFloor.value))}>
                                Save
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setEditFloor(null)}>
                                Cancel
                              </Button>
                            </div>
                          ) : (
                            <div className="flex items-center justify-between">
                              <div>
                                <p className="text-2xl font-bold text-accent">
                                  ${floor.ratePerDay.toFixed(2)}
                                  <span className="text-sm font-normal" style={{ color: 'var(--text-muted)' }}>/day</span>
                                </p>
                                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                  Default: ${floor.defaultFloor}/day
                                </p>
                              </div>
                              <Button size="sm" variant="ghost" onClick={() => setEditFloor({ tier: floor.gpuTier, value: floor.ratePerDay.toString() })}>
                                Edit
                              </Button>
                            </div>
                          )}
                        </div>
                      )) : (
                        <p className="py-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>No yield floors configured</p>
                      )}
                    </div>
                  </FormSection>
                </FormCard>

                <FormCard title="Market Configuration" description="Enable or disable external markets" icon={Route}>
                  <FormSection>
                    <div className="space-y-3">
                      {Array.isArray(markets) && markets.length > 0 ? markets.map((market) => (
                        <div key={market.market} className="p-4 bg-background/50 rounded-xl border border-border/50">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                                market.market === 'INTERNAL' ? 'bg-accent/20' :
                                market.market === 'AKASH' ? 'bg-blue-500/20' :
                                market.market === 'IONET' ? 'bg-purple-500/20' : ''
                              }`} style={market.market === 'VASTAI' ? { background: 'rgba(234,179,8,0.18)' } : undefined}>
                                <span className={`text-sm font-bold ${
                                  market.market === 'INTERNAL' ? 'text-accent' :
                                  market.market === 'AKASH' ? 'text-blue-400' :
                                  market.market === 'IONET' ? 'text-purple-400' : ''
                                }`} style={market.market === 'VASTAI' ? { color: '#eab308' } : undefined}>
                                  {market.market.charAt(0)}
                                </span>
                              </div>
                              <div>
                                <span className={`font-medium ${
                                  market.market === 'INTERNAL' ? 'text-accent' :
                                  market.market === 'AKASH' ? 'text-blue-400' :
                                  market.market === 'IONET' ? 'text-purple-400' : ''
                                }`} style={market.market === 'VASTAI' ? { color: '#eab308' } : undefined}>
                                  {market.market === 'VASTAI' ? 'VAST.AI' : market.market}
                                </span>
                                {market.market === 'INTERNAL' && (
                                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Always enabled (premium rate)</p>
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
                        <p className="py-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>No markets configured</p>
                      )}
                    </div>
                  </FormSection>
                </FormCard>
              </>
            )}

            {activeTab === 'settlements' && (
              <>
                <FormCard title="Auto-Schedule" description="Automatic settlement scheduling" icon={Calendar}>
                  <FormSection>
                    {settlementConfig ? (
                      <div className="space-y-4">
                        <div className="p-4 bg-background/50 rounded-xl border border-border/50">
                          <div className="flex items-center justify-between">
                            <div>
                              <span className="font-medium" style={{ color: 'var(--text-primary)' }}>Enable Auto-Scheduling</span>
                              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
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

                        <div className="p-4 bg-background/50 rounded-xl border border-border/50 space-y-3">
                          <div className="flex items-center justify-between">
                            <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Period</span>
                            <span className="px-3 py-1 bg-accent/10 text-accent text-sm rounded-full font-medium">
                              {settlementConfig.period.toUpperCase()}
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Schedule Hour</span>
                            <select
                              value={settlementConfig.hour}
                              onChange={(e) => handleUpdateScheduleHour(parseInt(e.target.value))}
                              disabled={updating === 'hour'}
                              className="px-3 py-1.5 bg-surface border border-border rounded-lg text-sm focus:outline-none focus:border-accent"
                              style={{ color: 'var(--text-primary)' }}
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
                              <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Day of Week</span>
                              <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                                {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][settlementConfig.dayOfWeek]}
                              </span>
                            </div>
                          )}
                          {settlementConfig.period === 'monthly' && settlementConfig.dayOfMonth !== null && (
                            <div className="flex items-center justify-between">
                              <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Day of Month</span>
                              <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{settlementConfig.dayOfMonth}</span>
                            </div>
                          )}
                          <div className="flex items-center justify-between">
                            <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Last Scheduled</span>
                            <span className="text-sm" style={{ color: 'var(--text-primary)' }}>
                              {settlementConfig.lastScheduledAt
                                ? new Date(settlementConfig.lastScheduledAt).toLocaleString()
                                : 'Never'}
                            </span>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <p className="py-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>Unable to load settlement config</p>
                    )}
                  </FormSection>
                </FormCard>

                <FormCard title="Failed Settlements" description="Settlements that need attention" icon={AlertTriangle}>
                  <FormSection>
                    <div className="space-y-4">
                      {failedSettlements.retriable.length > 0 && (
                        <div className="space-y-3">
                          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Retriable ({failedSettlements.retriable.length})</p>
                          {failedSettlements.retriable.map((s) => (
                            <div key={s.id} className="p-4 bg-background/50 rounded-xl border border-warning/30">
                              <div className="flex items-center justify-between mb-2">
                                <span className="font-medium font-mono text-sm" style={{ color: 'var(--text-primary)' }}>
                                  {s.walletAddress.slice(0, 8)}...{s.walletAddress.slice(-4)}
                                </span>
                                <span className="text-accent font-bold">${s.amount.toFixed(2)}</span>
                              </div>
                              <div className="flex items-center justify-between text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
                                <span>Retry {s.retryCount}/{s.maxRetries}</span>
                                {s.nextRetryAt && <span>Next: {new Date(s.nextRetryAt).toLocaleTimeString()}</span>}
                              </div>
                              <Button size="sm" variant="outline" className="w-full" loading={retrying === s.id} onClick={() => handleRetrySettlement(s.id)}>
                                Retry Now
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}

                      {failedSettlements.exhausted.length > 0 && (
                        <div className="space-y-3">
                          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Exhausted Retries ({failedSettlements.exhausted.length})</p>
                          {failedSettlements.exhausted.map((s) => (
                            <div key={s.id} className="p-4 bg-background/50 rounded-xl border border-error/30">
                              <div className="flex items-center justify-between mb-2">
                                <span className="font-medium font-mono text-sm" style={{ color: 'var(--text-primary)' }}>
                                  {s.walletAddress.slice(0, 8)}...{s.walletAddress.slice(-4)}
                                </span>
                                <span className="text-error font-bold">${s.amount.toFixed(2)}</span>
                              </div>
                              <div className="flex items-center justify-between text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
                                <span>Retried {s.retryCount} times</span>
                                <span className="text-error">Max retries exhausted</span>
                              </div>
                              <Button size="sm" variant="outline" className="w-full border-error/30 text-error hover:bg-error/10" loading={retrying === s.id} onClick={() => handleRetrySettlement(s.id)}>
                                Force Retry
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}

                      {failedSettlements.retriable.length === 0 && failedSettlements.exhausted.length === 0 && (
                        <div className="py-8 text-center">
                          <div className="w-12 h-12 rounded-xl bg-accent/10 flex items-center justify-center mx-auto mb-3">
                            <Check className="w-6 h-6 text-accent" />
                          </div>
                          <p className="text-accent text-sm font-medium">All settlements healthy</p>
                          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>No failed settlements</p>
                        </div>
                      )}
                    </div>
                  </FormSection>
                </FormCard>
              </>
            )}

            {activeTab === 'health' && (
              <FormCard title="Service Status" description="Real-time status of system components" icon={Server}>
                <FormSection>
                  {systemHealth ? (
                    <div className="space-y-3">
                      <div className="p-4 bg-background/50 rounded-xl border border-border/50 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span className={`w-2.5 h-2.5 rounded-full ${getStatusDotColor(systemHealth.services.database.status)}`} />
                          <span className="font-medium" style={{ color: 'var(--text-primary)' }}>Database (PostgreSQL)</span>
                        </div>
                        <div className="text-right flex items-center gap-3">
                          <span className={`text-sm font-medium ${getStatusColor(systemHealth.services.database.status)}`}>
                            {systemHealth.services.database.status}
                          </span>
                          <span className="text-xs px-2 py-1 bg-surface-hover rounded-lg" style={{ color: 'var(--text-muted)' }}>
                            {systemHealth.services.database.latencyMs}ms
                          </span>
                        </div>
                      </div>

                      <div className="p-4 bg-background/50 rounded-xl border border-border/50 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span className={`w-2.5 h-2.5 rounded-full ${getStatusDotColor(systemHealth.services.redis.status)}`} />
                          <span className="font-medium" style={{ color: 'var(--text-primary)' }}>Redis Cache</span>
                        </div>
                        <div className="text-right flex items-center gap-3">
                          <span className={`text-sm font-medium ${getStatusColor(systemHealth.services.redis.status)}`}>
                            {systemHealth.services.redis.status}
                          </span>
                          <span className="text-xs px-2 py-1 bg-surface-hover rounded-lg" style={{ color: 'var(--text-muted)' }}>
                            {systemHealth.services.redis.latencyMs}ms
                          </span>
                          {systemHealth.services.redis.memoryUsage && (
                            <span className="text-xs px-2 py-1 bg-surface-hover rounded-lg" style={{ color: 'var(--text-muted)' }}>
                              {systemHealth.services.redis.memoryUsage}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="p-4 bg-background/50 rounded-xl border border-border/50">
                        <div className="flex items-center justify-between mb-4">
                          <div className="flex items-center gap-3">
                            <span className={`w-2.5 h-2.5 rounded-full ${getStatusDotColor(systemHealth.services.jobQueue.status)}`} />
                            <span className="font-medium" style={{ color: 'var(--text-primary)' }}>Job Queue (BullMQ)</span>
                          </div>
                          <span className={`text-sm font-medium ${getStatusColor(systemHealth.services.jobQueue.status)}`}>
                            {systemHealth.services.jobQueue.status}
                          </span>
                        </div>
                        <div className="grid grid-cols-4 gap-4">
                          <div className="text-center p-3 bg-warning/5 rounded-lg border border-warning/20">
                            <p className="text-xl font-bold text-warning">{systemHealth.services.jobQueue.waiting}</p>
                            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Waiting</p>
                          </div>
                          <div className="text-center p-3 bg-blue-500/5 rounded-lg border border-blue-500/20">
                            <p className="text-xl font-bold text-blue-400">{systemHealth.services.jobQueue.active}</p>
                            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Active</p>
                          </div>
                          <div className="text-center p-3 bg-accent/5 rounded-lg border border-accent/20">
                            <p className="text-xl font-bold text-accent">{systemHealth.services.jobQueue.completed}</p>
                            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Completed</p>
                          </div>
                          <div className="text-center p-3 bg-error/5 rounded-lg border border-error/20">
                            <p className="text-xl font-bold text-error">{systemHealth.services.jobQueue.failed}</p>
                            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Failed</p>
                          </div>
                        </div>
                      </div>

                      <div className="p-4 bg-background/50 rounded-xl border border-border/50 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span className={`w-2.5 h-2.5 rounded-full ${getStatusDotColor(systemHealth.services.rateFetcher.status)}`} />
                          <span className="font-medium" style={{ color: 'var(--text-primary)' }}>Rate Fetcher</span>
                        </div>
                        <div className="text-right">
                          <span className={`text-sm font-medium ${getStatusColor(systemHealth.services.rateFetcher.status)}`}>
                            {systemHealth.services.rateFetcher.status}
                          </span>
                          {systemHealth.services.rateFetcher.lastRun && (
                            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                              Last: {new Date(systemHealth.services.rateFetcher.lastRun).toLocaleTimeString()}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <p className="py-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>Unable to fetch system health data</p>
                  )}
                </FormSection>
              </FormCard>
            )}

            {activeTab === 'payment' && (
              <>
                {paymentMode ? (
                  <>
                    <div className={`p-6 rounded-2xl border ${
                      paymentMode.devMode
                        ? 'bg-gradient-to-r from-warning/10 to-orange-500/5 border-warning/30'
                        : 'bg-gradient-to-r from-accent/10 to-emerald-500/5 border-accent/30'
                    }`}>
                      <div className="flex items-center gap-4">
                        <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${
                          paymentMode.devMode ? 'bg-warning/20' : 'bg-accent/20'
                        }`}>
                          <Wallet className={`w-6 h-6 ${paymentMode.devMode ? 'text-warning' : 'text-accent'}`} />
                        </div>
                        <div>
                          <div className="flex items-center gap-3 mb-1">
                            <span className={`px-4 py-1.5 rounded-full text-sm font-bold ${
                              paymentMode.devMode ? 'bg-warning/20 text-warning' : 'bg-accent/20 text-accent'
                            }`}>
                              {paymentMode.mode.toUpperCase()} MODE
                            </span>
                          </div>
                          <p style={{ color: 'var(--text-secondary)' }}>{paymentMode.description}</p>
                        </div>
                      </div>
                    </div>

                    <FormCard title="Payment Configuration" description="Solana payment system status" icon={Wallet}>
                      <FormSection>
                        <div className="space-y-3">
                          <div className="p-4 bg-background/50 rounded-xl border border-border/50 flex items-center justify-between">
                            <div>
                              <span className="font-medium" style={{ color: 'var(--text-primary)' }}>Solana RPC</span>
                              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>Connection to Solana network</p>
                            </div>
                            <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                              paymentMode.rpcConfigured ? 'bg-accent/10 text-accent' : 'bg-warning/10 text-warning'
                            }`}>
                              {paymentMode.rpcConfigured ? 'Configured' : 'Not Configured'}
                            </span>
                          </div>

                          <div className="p-4 bg-background/50 rounded-xl border border-border/50 flex items-center justify-between">
                            <div>
                              <span className="font-medium" style={{ color: 'var(--text-primary)' }}>Payer Wallet</span>
                              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>Wallet for sending payments</p>
                            </div>
                            <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                              paymentMode.payerConfigured ? 'bg-accent/10 text-accent' : 'bg-warning/10 text-warning'
                            }`}>
                              {paymentMode.payerConfigured ? 'Configured' : 'Not Configured'}
                            </span>
                          </div>

                          {paymentMode.devMode && (
                            <div className="p-4 bg-warning/5 border border-warning/20 rounded-xl flex items-center gap-3">
                              <AlertTriangle className="w-5 h-5 text-warning shrink-0" />
                              <p className="text-sm text-warning">
                                <strong>Dev Mode Active:</strong> Payments are simulated. Configure Solana RPC and payer wallet to enable live payments.
                              </p>
                            </div>
                          )}
                        </div>
                      </FormSection>
                    </FormCard>

                    <FormCard title="Payment Settings" description="Configure payment behavior" icon={CreditCard}>
                      <FormSection>
                        <div className="space-y-3">
                          <div className="p-4 bg-background/50 rounded-xl border border-border/50">
                            <p className="text-sm mb-3" style={{ color: 'var(--text-muted)' }}>Supported Currencies</p>
                            <div className="flex gap-2">
                              <span className="px-4 py-2 bg-accent/10 text-accent text-sm rounded-lg font-medium flex items-center gap-2">
                                USDC
                              </span>
                              <span className="px-4 py-2 bg-purple-500/10 text-purple-400 text-sm rounded-lg font-medium flex items-center gap-2">
                                SOL
                              </span>
                            </div>
                          </div>
                          <div className="p-4 bg-background/50 rounded-xl border border-border/50 flex items-center justify-between">
                            <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Network</span>
                            <span className="font-medium" style={{ color: 'var(--text-primary)' }}>Solana Mainnet</span>
                          </div>
                        </div>
                      </FormSection>
                    </FormCard>
                  </>
                ) : (
                  <FormCard title="Payment Configuration">
                    <FormSection>
                      <p className="py-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>Unable to fetch payment configuration</p>
                    </FormSection>
                  </FormCard>
                )}
              </>
            )}

            {activeTab === 'email' && (
              <>
                <FormCard title="SMTP Configuration" description="Configure email delivery settings" icon={Mail} actions={
                  <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                    smtpConfig.configured ? 'bg-accent/10 text-accent' : 'bg-warning/10 text-warning'
                  }`}>
                    {smtpConfig.configured ? 'Configured' : 'Not Configured'}
                  </span>
                }>
                  <FormSection>
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
                        <span className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>Secure Connection (TLS)</span>
                        <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>Enable TLS encryption for email transport</p>
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
                      placeholder='TokenOS DeAI Engine <noreply@tokenos.ai>'
                      value={smtpConfig.fromAddress}
                      onChange={(e) => setSmtpConfig(prev => ({ ...prev, fromAddress: e.target.value }))}
                    />

                    <Button onClick={handleSaveSmtp} loading={smtpSaving} className="w-full">
                      Save SMTP Settings
                    </Button>
                  </FormSection>
                </FormCard>

                <FormCard title="Send Test Email" description="Verify your SMTP configuration works" icon={Send}>
                  <FormSection>
                    {!smtpConfig.configured && (
                      <div className="p-4 bg-warning/5 border border-warning/20 rounded-xl flex items-center gap-3">
                        <AlertTriangle className="w-5 h-5 text-warning shrink-0" />
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

                    <Button onClick={handleTestEmail} loading={testingSend} variant="outline" className="w-full" disabled={!smtpConfig.configured || !testEmail}>
                      Send Test Email
                    </Button>
                  </FormSection>
                </FormCard>
              </>
            )}

            {activeTab === 'audit' && (
              <FormCard title="Audit Log" description="System change history" icon={Tag}>
                <FormSection>
                  <AuditLog />
                </FormSection>
              </FormCard>
            )}
          </>
        )}
      </div>
    </DashboardShell>
  )
}
