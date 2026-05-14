'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { DollarSign, TrendingUp, TrendingDown, BarChart3, AlertTriangle, FlaskConical, ShieldCheck, Pencil, Briefcase, Clock, Download, Banknote, Receipt, Check, Wallet, Settings as SettingsIcon } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { DistributionBar } from '@/components/ui/ProgressBar'
import { useToast } from '@/components/ui/Toast'
import { api } from '@/lib/api'
import {
  DashboardShell,
  DashboardMainColumn,
  DashboardRightRail,
  SectionCard,
  MetricTriad,
} from '@/components/dashboard/FuturisticShell'

interface ReportSummary {
  period: { start: string; end: string }
  revenue: { total: number; gpuHours: number; jobCount: number }
  costs: { total: number }
  profit: { gross: number; margin: number }
  settlements: { completed: number; amount: number }
  activity: { totalJobs: number; activeNodes: number }
}

interface EarningsByMarket {
  period: { start: string; end: string }
  total: { earnings: number; gpuHours: number; jobCount: number }
  byMarket: Record<string, { earnings: number; gpuHours: number; jobCount: number }>
}

interface CostsSummary {
  period: { start: string; end: string }
  total: number
  byCategory: Record<string, number>
}

interface Settlement {
  id: string
  nodeId: string
  walletAddress: string
  gpuTier: string
  amount: number
  status: string
  jobCount: number
  txHash: string | null
  createdAt: string
  processedAt: string | null
}

interface PendingSettlement {
  nodeId: string
  walletAddress: string
  amount: number
  jobCount: number
}

interface PaymentMode {
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
  solanaRpcUrl: string | null
  usdcMint: string | null
}

interface WalletBalance {
  isDevMode: boolean
  balances: {
    sol: number
    usdc: number
  }
  error?: string
  message: string
}

export default function FinancialPage() {
  const { addToast } = useToast()
  const [summary, setSummary] = useState<ReportSummary | null>(null)
  const [earningsByMarket, setEarningsByMarket] = useState<EarningsByMarket | null>(null)
  const [costsSummary, setCostsSummary] = useState<CostsSummary | null>(null)
  const [settlements, setSettlements] = useState<Settlement[]>([])
  const [pendingSettlements, setPendingSettlements] = useState<PendingSettlement[]>([])
  const [pendingTotal, setPendingTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [days, setDays] = useState(30)
  const [triggering, setTriggering] = useState(false)
  const [paymentMode, setPaymentMode] = useState<PaymentMode | null>(null)
  const [processingPayment, setProcessingPayment] = useState<string | null>(null)
  const [settlementConfig, setSettlementConfig] = useState<SettlementConfig | null>(null)
  const [editingConfig, setEditingConfig] = useState(false)
  const [configForm, setConfigForm] = useState<Partial<SettlementConfig & { solanaRpcUrl?: string; payerPrivateKey?: string; usdcMint?: string }>>({})
  const [savingConfig, setSavingConfig] = useState(false)
  const [walletBalance, setWalletBalance] = useState<WalletBalance | null>(null)
  const [editingSolanaConfig, setEditingSolanaConfig] = useState(false)
  const [solanaForm, setSolanaForm] = useState<{ rpcUrl: string; privateKey: string; usdcMint: string }>({ rpcUrl: '', privateKey: '', usdcMint: '' })
  const [savingSolana, setSavingSolana] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    loadData()
  }, [days])

  async function loadData(isRefresh = false) {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    try {
      const [summaryData, earningsData, costsData, settlementsData, pendingData, modeData, configData, balanceData] = await Promise.all([
        api.reports.summary({ days }),
        api.earnings.byMarket({ days }),
        api.costs.summary({ days }),
        api.settlements.list({ limit: 10 }),
        api.settlements.pending(),
        api.payments.mode(),
        api.settlements.config(),
        api.payments.balance(),
      ])

      setSummary(summaryData)
      setEarningsByMarket(earningsData)
      setCostsSummary(costsData)
      setSettlements(settlementsData.settlements)
      setPendingSettlements(pendingData.pending)
      setPendingTotal(pendingData.totalAmount)
      setPaymentMode(modeData)
      setSettlementConfig(configData)
      setWalletBalance(balanceData)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load financial data')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  async function handleTriggerSettlements() {
    setTriggering(true)
    try {
      const result = await api.settlements.trigger()
      addToast({ type: 'success', title: 'Settlements Created', message: `Created ${result.settlementIds.length} settlement(s)` })
      loadData()
    } catch (err) {
      addToast({ type: 'error', title: 'Error', message: err instanceof Error ? err.message : 'Failed to trigger settlements' })
    } finally {
      setTriggering(false)
    }
  }

  async function handleProcessPayment(settlementId: string) {
    if (!confirm(paymentMode?.devMode
      ? 'Process this payment in DEV MODE? (No real funds will be transferred)'
      : 'Process this payment? Real funds will be transferred.')) {
      return
    }

    setProcessingPayment(settlementId)
    try {
      const result = await api.payments.process(settlementId, 'USDC')
      addToast({
        type: 'success',
        title: result.isDevMode ? 'DEV MODE: Payment Simulated' : 'Payment Sent',
        message: `Tx: ${result.txHash.substring(0, 20)}...`
      })
      loadData()
    } catch (err) {
      addToast({ type: 'error', title: 'Payment Failed', message: err instanceof Error ? err.message : 'Failed to process payment' })
    } finally {
      setProcessingPayment(null)
    }
  }

  async function handleSaveConfig() {
    setSavingConfig(true)
    try {
      await api.settlements.updateConfig({
        period: configForm.period as 'daily' | 'weekly' | 'monthly',
        minimumPayout: configForm.minimumPayout || 10,
        dayOfWeek: configForm.period === 'weekly' ? configForm.dayOfWeek : null,
        dayOfMonth: configForm.period === 'monthly' ? configForm.dayOfMonth : null,
      })
      setEditingConfig(false)
      setConfigForm({})
      addToast({ type: 'success', title: 'Configuration Saved', message: 'Settlement configuration updated successfully' })
      loadData()
    } catch (err) {
      addToast({ type: 'error', title: 'Error', message: err instanceof Error ? err.message : 'Failed to save configuration' })
    } finally {
      setSavingConfig(false)
    }
  }

  async function handleSaveSolanaConfig() {
    setSavingSolana(true)
    try {
      await api.settlements.updateConfig({
        solanaRpcUrl: solanaForm.rpcUrl || undefined,
        payerPrivateKey: solanaForm.privateKey || undefined,
        usdcMint: solanaForm.usdcMint || undefined,
      })
      setEditingSolanaConfig(false)
      setSolanaForm({ rpcUrl: '', privateKey: '', usdcMint: '' })
      loadData()
      addToast({ type: 'success', title: 'Solana Config Updated', message: 'Set PAYMENT_MODE=live to enable live payments.' })
    } catch (err) {
      addToast({ type: 'error', title: 'Error', message: err instanceof Error ? err.message : 'Failed to save Solana configuration' })
    } finally {
      setSavingSolana(false)
    }
  }

  function formatCurrency(value: number): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
    }).format(value)
  }

  function formatPercent(value: number): string {
    return `${value.toFixed(1)}%`
  }

  function shortenAddress(address: string): string {
    return `${address.slice(0, 6)}...${address.slice(-4)}`
  }

  // Calculate revenue distribution for chart
  const revenueDistribution = earningsByMarket
    ? Object.entries(earningsByMarket.byMarket).map(([market, data]) => ({
        label: market,
        value: data.earnings,
        color: market === 'INTERNAL' ? 'accent' as const : market === 'AKASH' ? 'blue' as const : 'purple' as const,
      }))
    : []

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <div className="w-12 h-12 rounded-xl bg-surface-hover flex items-center justify-center mb-4">
          <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        </div>
        <p style={{ color: 'var(--text-muted)' }}>Loading financial data...</p>
      </div>
    )
  }

  if (error) {
    return (
      <DashboardShell title="Financial Overview" subtitle="Revenue, costs, settlements" onRefresh={() => loadData(true)} refreshing={refreshing}>
        <div className="lg:col-span-3">
          <SectionCard>
            <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
              <div className="w-14 h-14 rounded-full inline-flex items-center justify-center mb-4" style={{ background: 'rgba(239, 68, 68, 0.12)' }}>
                <AlertTriangle size={28} style={{ color: '#ef4444' }} />
              </div>
              <h2 className="font-display text-lg mb-1" style={{ color: 'var(--text-primary)' }}>Connection Error</h2>
              <p className="text-sm max-w-sm mb-5" style={{ color: 'var(--text-muted)' }}>{error}</p>
              <Button onClick={() => loadData()} variant="gradient">Try Again</Button>
            </div>
          </SectionCard>
        </div>
      </DashboardShell>
    )
  }

  return (
    <DashboardShell
      title="Financial Overview"
      subtitle="Revenue, costs, settlements"
      liveLabel="LIVE"
      onRefresh={() => loadData(true)}
      refreshing={refreshing}
    >
      <DashboardMainColumn>
        {/* Period selector */}
        <div className="flex items-center justify-end">
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="px-4 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent"
            style={{ color: 'var(--text-primary)' }}
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </div>

        <MetricTriad
          metrics={[
            {
              label: 'Total Revenue',
              value: formatCurrency(summary?.revenue.total ?? 0),
              detail: `${(summary?.revenue.gpuHours ?? 0).toFixed(1)} GPU-hrs`,
              icon: DollarSign,
              tone: 'green',
            },
            {
              label: 'Total Costs',
              value: formatCurrency(summary?.costs.total ?? 0),
              icon: Receipt,
              tone: 'orange',
            },
            {
              label: 'Net Profit',
              value: formatCurrency(summary?.profit.gross ?? 0),
              detail: `Margin ${formatPercent(summary?.profit.margin ?? 0)}`,
              icon: TrendingUp,
              tone: 'blue',
            },
          ]}
        />

        {/* Revenue and Costs Breakdown */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <SectionCard title="Revenue by Market" icon={BarChart3}>
            {earningsByMarket && Object.keys(earningsByMarket.byMarket).length > 0 ? (
              <div className="space-y-6">
                <DistributionBar segments={revenueDistribution} size="lg" showLegend />
                <div className="space-y-3">
                  {Object.entries(earningsByMarket.byMarket).map(([market, data]) => {
                    const total = earningsByMarket.total.earnings
                    const percentage = total > 0 ? (data.earnings / total) * 100 : 0
                    return (
                      <div key={market} className="p-4 bg-surface/50 rounded-xl border border-border/50">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <span
                              className={`w-3 h-3 rounded-full ${
                                market === 'INTERNAL'
                                  ? 'bg-accent'
                                  : market === 'AKASH'
                                  ? 'bg-accent-blue'
                                  : 'bg-accent-purple'
                              }`}
                            />
                            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{market}</span>
                          </div>
                          <span className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                            {formatCurrency(data.earnings)}
                          </span>
                        </div>
                        <div className="flex justify-between text-xs" style={{ color: 'var(--text-muted)' }}>
                          <span>{data.gpuHours.toFixed(1)} GPU hours</span>
                          <span>{data.jobCount} jobs ({percentage.toFixed(1)}%)</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
                <div className="pt-4 border-t border-border">
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Total Revenue</span>
                    <span className="text-lg font-bold text-accent">
                      {formatCurrency(earningsByMarket?.total.earnings ?? 0)}
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-sm py-8 text-center" style={{ color: 'var(--text-muted)' }}>No revenue yet</p>
            )}
          </SectionCard>

          <SectionCard title="Costs by Category" icon={Receipt}>
            {costsSummary && costsSummary.total > 0 ? (
              <div className="space-y-4">
                {Object.entries(costsSummary.byCategory)
                  .filter(([, amount]) => amount > 0)
                  .map(([category, amount]) => {
                    const percentage = (amount / costsSummary.total) * 100
                    const colors: Record<string, { bg: string }> = {
                      HOSTING: { bg: 'bg-red-500' },
                      POWER: { bg: 'bg-yellow-500' },
                      NETWORK: { bg: 'bg-blue-500' },
                      OTHER: { bg: 'bg-gray-500' },
                    }
                    const color = colors[category] ?? colors.OTHER
                    return (
                      <div key={category} className="p-4 bg-surface/50 rounded-xl border border-border/50">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <span className={`w-3 h-3 rounded-full ${color.bg}`} />
                            <span className="text-sm font-medium capitalize" style={{ color: 'var(--text-primary)' }}>{category.toLowerCase()}</span>
                          </div>
                          <span className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                            {formatCurrency(amount)}
                          </span>
                        </div>
                        <div className="h-2 bg-background rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${color.bg}`}
                            style={{ width: `${percentage}%` }}
                          />
                        </div>
                      </div>
                    )
                  })}
                <div className="pt-4 border-t border-border">
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Total Costs</span>
                    <span className="text-lg font-bold text-error">
                      {formatCurrency(costsSummary?.total ?? 0)}
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-sm py-8 text-center" style={{ color: 'var(--text-muted)' }}>No costs recorded</p>
            )}
          </SectionCard>
        </div>

        <SectionCard title="Pending Settlements" icon={Banknote}>
          <div className="flex items-center justify-between mb-4 p-4 bg-warning/5 border border-warning/20 rounded-xl">
            <div>
              <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Ready to Settle</p>
              <p className="text-2xl font-bold text-warning">{formatCurrency(pendingTotal)}</p>
            </div>
            <Button
              onClick={handleTriggerSettlements}
              variant="gradient"
              size="sm"
              disabled={triggering || pendingSettlements.length === 0}
            >
              {triggering ? 'Processing...' : 'Trigger All'}
            </Button>
          </div>

          {pendingSettlements.length > 0 ? (
            <div className="space-y-2">
              {pendingSettlements.map((ps) => (
                <div
                  key={ps.nodeId}
                  className="flex items-center justify-between p-3 bg-surface/50 rounded-xl border border-border/50 hover:border-border transition-colors"
                >
                  <div>
                    <p className="text-sm font-medium font-mono" style={{ color: 'var(--text-primary)' }}>
                      {shortenAddress(ps.walletAddress)}
                    </p>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{ps.jobCount} jobs</p>
                  </div>
                  <span className="text-sm font-bold text-accent">
                    {formatCurrency(ps.amount)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8">
              <div className="w-12 h-12 rounded-xl bg-surface-hover flex items-center justify-center mx-auto mb-3">
                <Check className="w-6 h-6 text-accent" />
              </div>
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No pending settlements</p>
            </div>
          )}
        </SectionCard>

        <SectionCard title="Recent Settlements" icon={Banknote}>
          {settlements.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left text-xs font-medium pb-3 uppercase" style={{ color: 'var(--text-muted)' }}>Wallet</th>
                    <th className="text-left text-xs font-medium pb-3 uppercase" style={{ color: 'var(--text-muted)' }}>Amount</th>
                    <th className="text-left text-xs font-medium pb-3 uppercase" style={{ color: 'var(--text-muted)' }}>Status</th>
                    <th className="text-left text-xs font-medium pb-3 uppercase" style={{ color: 'var(--text-muted)' }}>Jobs</th>
                    <th className="text-left text-xs font-medium pb-3 uppercase" style={{ color: 'var(--text-muted)' }}>Date</th>
                    <th className="text-left text-xs font-medium pb-3 uppercase" style={{ color: 'var(--text-muted)' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {settlements.map((s) => (
                    <tr key={s.id} className="border-b border-border/50 last:border-0 hover:bg-surface-hover/50 transition-colors">
                      <td className="py-4">
                        <Link href={`/settlements/${s.id}`} className="text-sm font-mono hover:text-accent transition-colors" style={{ color: 'var(--text-primary)' }}>
                          {shortenAddress(s.walletAddress)}
                        </Link>
                      </td>
                      <td className="py-4">
                        <span className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                          {formatCurrency(s.amount)}
                        </span>
                      </td>
                      <td className="py-4">
                        <span
                          className={`inline-flex px-2.5 py-1 text-xs font-medium rounded-lg ${
                            s.status === 'COMPLETED'
                              ? 'bg-accent/10 text-accent'
                              : s.status === 'PENDING'
                              ? 'bg-warning/10 text-warning'
                              : s.status === 'PROCESSING'
                              ? 'bg-accent-blue/10 text-accent-blue'
                              : 'bg-error/10 text-error'
                          }`}
                        >
                          {s.status}
                        </span>
                      </td>
                      <td className="py-4">
                        <span className="text-sm" style={{ color: 'var(--text-muted)' }}>{s.jobCount}</span>
                      </td>
                      <td className="py-4">
                        <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
                          {new Date(s.createdAt).toLocaleDateString()}
                        </span>
                      </td>
                      <td className="py-4">
                        <div className="flex items-center gap-2">
                          <Link
                            href={`/settlements/${s.id}`}
                            className="px-3 py-1.5 text-xs bg-surface-hover hover:bg-border rounded-lg transition-colors font-medium"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            View
                          </Link>
                          {s.status === 'PENDING' && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                handleProcessPayment(s.id)
                              }}
                              disabled={processingPayment === s.id}
                              className="px-3 py-1.5 bg-accent hover:bg-accent/80 disabled:bg-accent/50 text-white text-xs font-medium rounded-lg transition-colors"
                            >
                              {processingPayment === s.id ? 'Paying...' : 'Pay'}
                            </button>
                          )}
                          {s.status === 'COMPLETED' && s.txHash && (
                            <a
                              href={`https://solscan.io/tx/${s.txHash}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="text-xs text-accent hover:underline font-mono"
                            >
                              {s.txHash.substring(0, 12)}...
                            </a>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm py-8 text-center" style={{ color: 'var(--text-muted)' }}>No settlements yet</p>
          )}
        </SectionCard>

        <SectionCard title="Settlement Configuration" icon={SettingsIcon}>
          {!editingConfig ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="p-4 bg-surface/50 rounded-xl border border-border/50">
                  <p className="text-xs uppercase mb-1 font-medium" style={{ color: 'var(--text-muted)' }}>Settlement Period</p>
                  <p className="text-lg font-bold capitalize" style={{ color: 'var(--text-primary)' }}>
                    {settlementConfig?.period || 'Weekly'}
                  </p>
                </div>
                <div className="p-4 bg-surface/50 rounded-xl border border-border/50">
                  <p className="text-xs uppercase mb-1 font-medium" style={{ color: 'var(--text-muted)' }}>Minimum Payout</p>
                  <p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                    {formatCurrency(settlementConfig?.minimumPayout || 10)}
                  </p>
                </div>
                {settlementConfig?.period === 'weekly' && settlementConfig.dayOfWeek !== null && (
                  <div className="p-4 bg-surface/50 rounded-xl border border-border/50">
                    <p className="text-xs uppercase mb-1 font-medium" style={{ color: 'var(--text-muted)' }}>Settlement Day</p>
                    <p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                      {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][settlementConfig.dayOfWeek]}
                    </p>
                  </div>
                )}
                {settlementConfig?.period === 'monthly' && settlementConfig.dayOfMonth !== null && (
                  <div className="p-4 bg-surface/50 rounded-xl border border-border/50">
                    <p className="text-xs uppercase mb-1 font-medium" style={{ color: 'var(--text-muted)' }}>Settlement Day</p>
                    <p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                      Day {settlementConfig.dayOfMonth}
                    </p>
                  </div>
                )}
              </div>
              <Button
                onClick={() => {
                  setConfigForm({
                    period: settlementConfig?.period || 'weekly',
                    minimumPayout: settlementConfig?.minimumPayout || 10,
                    dayOfWeek: settlementConfig?.dayOfWeek ?? 1,
                    dayOfMonth: settlementConfig?.dayOfMonth ?? 1,
                  })
                  setEditingConfig(true)
                }}
                variant="secondary"
                size="sm"
                icon={<Pencil className="w-4 h-4" />}
              >
                Edit Configuration
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                    Settlement Period
                  </label>
                  <select
                    value={configForm.period || 'weekly'}
                    onChange={(e) => setConfigForm({ ...configForm, period: e.target.value })}
                    className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:border-accent"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                    Minimum Payout (USD)
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={configForm.minimumPayout || 10}
                    onChange={(e) => setConfigForm({ ...configForm, minimumPayout: Number(e.target.value) })}
                    className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:border-accent"
                    style={{ color: 'var(--text-primary)' }}
                  />
                </div>
                {configForm.period === 'weekly' && (
                  <div>
                    <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                      Day of Week
                    </label>
                    <select
                      value={configForm.dayOfWeek ?? 1}
                      onChange={(e) => setConfigForm({ ...configForm, dayOfWeek: Number(e.target.value) })}
                      className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:border-accent"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      <option value={0}>Sunday</option>
                      <option value={1}>Monday</option>
                      <option value={2}>Tuesday</option>
                      <option value={3}>Wednesday</option>
                      <option value={4}>Thursday</option>
                      <option value={5}>Friday</option>
                      <option value={6}>Saturday</option>
                    </select>
                  </div>
                )}
                {configForm.period === 'monthly' && (
                  <div>
                    <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                      Day of Month
                    </label>
                    <select
                      value={configForm.dayOfMonth ?? 1}
                      onChange={(e) => setConfigForm({ ...configForm, dayOfMonth: Number(e.target.value) })}
                      className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:border-accent"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      {Array.from({ length: 28 }, (_, i) => i + 1).map((day) => (
                        <option key={day} value={day}>
                          {day}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
              <div className="flex gap-3">
                <Button onClick={handleSaveConfig} variant="gradient" size="sm" disabled={savingConfig}>
                  {savingConfig ? 'Saving...' : 'Save Changes'}
                </Button>
                <Button
                  onClick={() => {
                    setEditingConfig(false)
                    setConfigForm({})
                  }}
                  variant="secondary"
                  size="sm"
                  disabled={savingConfig}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </SectionCard>

        <SectionCard title="Solana Payment Configuration" icon={SettingsIcon}>
          {!editingSolanaConfig ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="p-4 bg-surface/50 rounded-xl border border-border/50">
                  <p className="text-xs uppercase mb-1 font-medium" style={{ color: 'var(--text-muted)' }}>RPC Endpoint</p>
                  <p className="text-sm font-mono truncate" style={{ color: 'var(--text-primary)' }}>
                    {settlementConfig?.solanaRpcUrl || 'Not configured (using devnet)'}
                  </p>
                </div>
                <div className="p-4 bg-surface/50 rounded-xl border border-border/50">
                  <p className="text-xs uppercase mb-1 font-medium" style={{ color: 'var(--text-muted)' }}>USDC Mint</p>
                  <p className="text-sm font-mono truncate" style={{ color: 'var(--text-primary)' }}>
                    {settlementConfig?.usdcMint || 'Default (mainnet USDC)'}
                  </p>
                </div>
                <div className="p-4 bg-surface/50 rounded-xl border border-border/50">
                  <p className="text-xs uppercase mb-1 font-medium" style={{ color: 'var(--text-muted)' }}>Payer Wallet</p>
                  <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                    {paymentMode?.payerConfigured ? (
                      <span className="text-accent flex items-center gap-2">
                        <Check className="w-4 h-4" /> Configured
                      </span>
                    ) : (
                      <span className="text-warning flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4" /> Not configured
                      </span>
                    )}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Button onClick={() => setEditingSolanaConfig(true)} variant="secondary" size="sm" icon={<Pencil className="w-4 h-4" />}>
                  Configure Solana
                </Button>
                {!paymentMode?.devMode && (
                  <span className="text-xs text-accent font-medium">Live payments enabled</span>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="p-4 bg-warning/10 border border-warning/30 rounded-xl flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm text-warning font-medium">Security Warning</p>
                  <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                    Private keys are stored encrypted in the database. For production, consider using environment variables or a secrets manager.
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                    Solana RPC URL
                  </label>
                  <input
                    type="text"
                    value={solanaForm.rpcUrl}
                    onChange={(e) => setSolanaForm({ ...solanaForm, rpcUrl: e.target.value })}
                    placeholder="https://api.mainnet-beta.solana.com"
                    className="w-full px-4 py-3 bg-background border border-border rounded-xl font-mono text-sm focus:outline-none focus:border-accent"
                    style={{ color: 'var(--text-primary)' }}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                    Payer Private Key (JSON array format)
                  </label>
                  <input
                    type="password"
                    value={solanaForm.privateKey}
                    onChange={(e) => setSolanaForm({ ...solanaForm, privateKey: e.target.value })}
                    placeholder="[1,2,3,...] or leave empty to keep existing"
                    className="w-full px-4 py-3 bg-background border border-border rounded-xl font-mono text-sm focus:outline-none focus:border-accent"
                    style={{ color: 'var(--text-primary)' }}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                    USDC Mint Address (optional)
                  </label>
                  <input
                    type="text"
                    value={solanaForm.usdcMint}
                    onChange={(e) => setSolanaForm({ ...solanaForm, usdcMint: e.target.value })}
                    placeholder="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v (mainnet default)"
                    className="w-full px-4 py-3 bg-background border border-border rounded-xl font-mono text-sm focus:outline-none focus:border-accent"
                    style={{ color: 'var(--text-primary)' }}
                  />
                </div>
              </div>
              <div className="flex gap-3">
                <Button onClick={handleSaveSolanaConfig} variant="gradient" size="sm" disabled={savingSolana}>
                  {savingSolana ? 'Saving...' : 'Save Solana Config'}
                </Button>
                <Button
                  onClick={() => {
                    setEditingSolanaConfig(false)
                    setSolanaForm({ rpcUrl: '', privateKey: '', usdcMint: '' })
                  }}
                  variant="secondary"
                  size="sm"
                  disabled={savingSolana}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </SectionCard>

        <SectionCard title="Export Reports" icon={Download}>
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => api.reports.downloadCSV('earnings')} variant="secondary" size="sm" icon={<Download className="w-4 h-4" />}>
              Earnings CSV
            </Button>
            <Button onClick={() => api.reports.downloadCSV('settlements')} variant="secondary" size="sm" icon={<Download className="w-4 h-4" />}>
              Settlements CSV
            </Button>
            <Button onClick={() => api.reports.downloadCSV('jobs')} variant="secondary" size="sm" icon={<Download className="w-4 h-4" />}>
              Jobs CSV
            </Button>
            <Button onClick={() => api.reports.downloadCSV('nodes')} variant="secondary" size="sm" icon={<Download className="w-4 h-4" />}>
              Nodes CSV
            </Button>
          </div>
        </SectionCard>
      </DashboardMainColumn>

      <DashboardRightRail>
        {/* Payment Mode Banner */}
        {paymentMode && (
          <SectionCard title="Payment Mode" icon={paymentMode.devMode ? FlaskConical : ShieldCheck}>
            <div className="flex items-center gap-4">
              <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${
                paymentMode.devMode ? 'bg-warning/10' : 'bg-accent/10'
              }`}>
                {paymentMode.devMode ? (
                  <FlaskConical className="w-6 h-6 text-warning" />
                ) : (
                  <ShieldCheck className="w-6 h-6 text-accent" />
                )}
              </div>
              <div>
                <span className={`px-3 py-1 rounded-full text-xs font-bold ${
                  paymentMode.devMode
                    ? 'bg-warning/20 text-warning'
                    : 'bg-accent/20 text-accent'
                }`}>
                  {paymentMode.mode.toUpperCase()} MODE
                </span>
                <p className={`text-sm mt-1 ${paymentMode.devMode ? 'text-warning/80' : 'text-accent/80'}`}>
                  {paymentMode.description}
                </p>
              </div>
            </div>
          </SectionCard>
        )}

        {/* Payer Wallet Balance */}
        {walletBalance && (
          <SectionCard title="Payer Wallet" icon={Wallet}>
            <div className="space-y-3">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-muted)' }}>SOL</p>
                <p className="font-display text-2xl" style={{ color: 'var(--text-primary)' }}>{walletBalance.balances.sol.toFixed(4)}</p>
              </div>
              <div className="pt-3 border-t border-border-subtle">
                <p className="font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-muted)' }}>USDC</p>
                <p className="font-display text-2xl text-accent">${walletBalance.balances.usdc.toFixed(2)}</p>
              </div>
              {walletBalance.isDevMode && (
                <span className="inline-block px-3 py-1.5 text-xs bg-warning/10 text-warning rounded-lg font-medium">Simulated</span>
              )}
              {walletBalance.error && (
                <p className="text-xs text-error mt-3 p-2 bg-error/10 rounded-lg">{walletBalance.error}</p>
              )}
            </div>
          </SectionCard>
        )}

        <SectionCard title="Activity Snapshot" icon={Briefcase}>
          <div className="space-y-3">
            <Stat label="Total Jobs" value={String(summary?.activity.totalJobs ?? 0)} />
            <Stat label="GPU Hours" value={(summary?.revenue.gpuHours ?? 0).toFixed(1)} />
            <Stat label="Completed Settlements" value={String(summary?.settlements.completed ?? 0)} />
            <Stat label="Settled Amount" value={formatCurrency(summary?.settlements.amount ?? 0)} />
          </div>
        </SectionCard>
      </DashboardRightRail>
    </DashboardShell>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-baseline">
      <span className="font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span className="font-display text-sm" style={{ color: 'var(--text-primary)' }}>{value}</span>
    </div>
  )
}
