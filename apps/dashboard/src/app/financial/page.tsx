'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { DollarSign, TrendingUp, TrendingDown, BarChart3, RefreshCw, AlertTriangle, Pencil, Briefcase, Clock, Download, Banknote, Receipt, Check } from 'lucide-react'
import { Card, StatCard } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { DistributionBar } from '@/components/ui/ProgressBar'
import { useToast } from '@/components/ui/Toast'
import { api } from '@/lib/api'

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

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

  useEffect(() => {
    loadData()
  }, [days])

  async function loadData() {
    setLoading(true)
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
      <div className="flex flex-col items-center justify-center py-20 animate-fadeIn">
        <div className="w-12 h-12 rounded-xl bg-surface-hover flex items-center justify-center mb-4">
          <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        </div>
        <p className="text-text-muted">Loading financial data...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="max-w-md mx-auto mt-20 animate-fadeIn">
        <Card variant="elevated" className="text-center">
          <div className="w-16 h-16 rounded-full bg-error/10 flex items-center justify-center mx-auto mb-4">
            <AlertTriangle className="w-8 h-8 text-error" />
          </div>
          <h2 className="text-lg font-semibold text-text-primary mb-2">Connection Error</h2>
          <p className="text-text-muted text-sm mb-6">{error}</p>
          <Button onClick={loadData} variant="gradient">
            Try Again
          </Button>
        </Card>
      </div>
    )
  }

  return (
    <motion.div variants={container} initial="hidden" animate="show" className="space-y-8">
      {/* Header */}
      <motion.div variants={item} className="dash-header">
        <div className="dash-header-left">
          <h1><BarChart3 size={28} /> Financial Overview</h1>
        </div>
        <div className="dash-header-right">
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-text-primary focus:outline-none focus:border-accent"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <button className="dash-refresh-btn" onClick={loadData} title="Refresh data">
            <RefreshCw size={16} />
          </button>
        </div>
      </motion.div>

      {/* KPI Stat Blocks.
          Labels reflect what the underlying data ACTUALLY sums to.
          Earning.earnings holds the operator's slice from the 3-way
          revenue split (rental-credit.ts:197), so the green block is
          operator earnings paid out, NOT platform gross revenue from
          buyers. Costs is admin-entered infrastructure spend. Net is
          their difference — useful as an operator-flow vs infra-spend
          read, but NOT platform net profit (which would also need
          buyer-side gross and staking/treasury slices). Replace with
          a buyer-side gross widget when the BalanceTransaction roll-up
          ships. */}
      <motion.div variants={item} className="stat-blocks">
        <div className="stat-block green">
          <div className="stat-icon"><DollarSign size={20} /></div>
          <div className="stat-content">
            <span className="stat-value">{formatCurrency(summary?.revenue.total ?? 0)}</span>
            <span className="stat-label">Operator Earnings</span>
          </div>
        </div>
        <div className="stat-block red">
          <div className="stat-icon"><Receipt size={20} /></div>
          <div className="stat-content">
            <span className="stat-value">{formatCurrency(summary?.costs.total ?? 0)}</span>
            <span className="stat-label">Infrastructure Costs</span>
          </div>
        </div>
        <div className="stat-block blue">
          <div className="stat-icon"><TrendingUp size={20} /></div>
          <div className="stat-content">
            <span className="stat-value">{formatCurrency(summary?.profit.gross ?? 0)}</span>
            <span className="stat-label">Net (Earnings &minus; Infra)</span>
          </div>
        </div>
        <div className="stat-block purple">
          <div className="stat-icon"><BarChart3 size={20} /></div>
          <div className="stat-content">
            <span className="stat-value">{formatPercent(summary?.profit.margin ?? 0)}</span>
            <span className="stat-label">Margin</span>
          </div>
        </div>
      </motion.div>

      {/* Wallet Balance. The full-width "LIVE MODE" banner was removed —
          its description was redundant with the small mode pill that
          already appears in Settings, and it ate screen real estate
          without adding actionable info. The payment-mode signal is
          still surfaced via the "Live payments enabled" line in the
          Settings section below. */}
      <div className="grid grid-cols-1 gap-4">
        {/* Payer Wallet Balance */}
        {walletBalance && (
          <Card variant="glass" className="p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-text-muted uppercase mb-2 font-medium">Payer Wallet Balance</p>
                <div className="flex items-center gap-6">
                  <div>
                    <span className="text-2xl font-bold text-text-primary">{walletBalance.balances.sol.toFixed(4)}</span>
                    <span className="text-sm text-text-muted ml-2">SOL</span>
                  </div>
                  <div className="border-l border-border pl-6">
                    <span className="text-2xl font-bold text-accent">${walletBalance.balances.usdc.toFixed(2)}</span>
                    <span className="text-sm text-text-muted ml-2">USDC</span>
                  </div>
                </div>
              </div>
              {walletBalance.isDevMode && (
                <span className="px-3 py-1.5 text-xs bg-warning/10 text-warning rounded-lg font-medium">Simulated</span>
              )}
            </div>
            {walletBalance.error && (
              <p className="text-xs text-error mt-3 p-2 bg-error/10 rounded-lg">{walletBalance.error}</p>
            )}
          </Card>
        )}
      </div>

      {/* Key Metrics. Mirror of the KPI Stat Blocks above with the
          same labels, kept in sync so the two widget grids tell the
          same story. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Operator Earnings"
          value={formatCurrency(summary?.revenue.total ?? 0)}
          variant="accent"
          icon={<TrendingUp className="w-4 h-4" />}
        />
        <StatCard
          label="Infrastructure Costs"
          value={formatCurrency(summary?.costs.total ?? 0)}
          variant="default"
          icon={<TrendingDown className="w-4 h-4" />}
        />
        <StatCard
          label="Net (Earnings − Infra)"
          value={formatCurrency(summary?.profit.gross ?? 0)}
          variant={summary?.profit.gross && summary.profit.gross > 0 ? 'accent' : 'default'}
          icon={<DollarSign className="w-4 h-4" />}
        />
        <StatCard
          label="Margin"
          value={formatPercent(summary?.profit.margin ?? 0)}
          variant="purple"
          icon={<BarChart3 className="w-4 h-4" />}
        />
      </div>

      {/* Revenue and Costs Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Operator earnings by market (same Earning.earnings source
            as the KPI green block). */}
        <Card variant="glass" title="Operator Earnings by Market" description="Distribution across markets">
          {earningsByMarket && Object.keys(earningsByMarket.byMarket).length > 0 ? (
            <div className="space-y-6 mt-4">
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
                          <span className="text-sm font-medium text-text-primary">{market}</span>
                        </div>
                        <span className="text-sm font-bold text-text-primary">
                          {formatCurrency(data.earnings)}
                        </span>
                      </div>
                      <div className="flex justify-between text-xs text-text-muted">
                        <span>{data.gpuHours.toFixed(1)} GPU hours</span>
                        <span>{data.jobCount} jobs ({percentage.toFixed(1)}%)</span>
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="pt-4 border-t border-border">
                <div className="flex justify-between items-center">
                  <span className="text-sm font-medium text-text-primary">Total Revenue</span>
                  <span className="text-lg font-bold text-accent">
                    {formatCurrency(earningsByMarket?.total.earnings ?? 0)}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <EmptyState
              icon={<BarChart3 className="w-8 h-8" />}
              title="No revenue yet"
              description="Revenue will appear here once jobs complete"
            />
          )}
        </Card>

        {/* Costs by Category */}
        <Card variant="glass" title="Costs by Category" description="Breakdown of operating costs">
          {costsSummary && costsSummary.total > 0 ? (
            <div className="space-y-4 mt-4">
              {Object.entries(costsSummary.byCategory)
                .filter(([, amount]) => amount > 0)
                .map(([category, amount]) => {
                  const percentage = (amount / costsSummary.total) * 100
                  const colors: Record<string, { bg: string; text: string }> = {
                    HOSTING: { bg: 'bg-red-500', text: 'text-red-400' },
                    POWER: { bg: 'bg-yellow-500', text: 'text-yellow-400' },
                    NETWORK: { bg: 'bg-blue-500', text: 'text-blue-400' },
                    OTHER: { bg: 'bg-gray-500', text: 'text-gray-400' },
                  }
                  const color = colors[category] ?? colors.OTHER
                  return (
                    <div key={category} className="p-4 bg-surface/50 rounded-xl border border-border/50">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className={`w-3 h-3 rounded-full ${color.bg}`} />
                          <span className="text-sm font-medium text-text-primary capitalize">{category.toLowerCase()}</span>
                        </div>
                        <span className="text-sm font-bold text-text-primary">
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
                  <span className="text-sm font-medium text-text-primary">Total Costs</span>
                  <span className="text-lg font-bold text-error">
                    {formatCurrency(costsSummary?.total ?? 0)}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <EmptyState
              icon={<Receipt className="w-8 h-8" />}
              title="No costs recorded"
              description="Cost entries will appear here"
            />
          )}
        </Card>
      </div>

      {/* Settlements Section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Pending Settlements */}
        <Card variant="glass" title="Pending Settlements" className="lg:col-span-1">
          <div className="mt-4">
            <div className="flex items-center justify-between mb-4 p-4 bg-warning/5 border border-warning/20 rounded-xl">
              <div>
                <p className="text-sm font-medium text-text-primary">Ready to Settle</p>
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
                      <p className="text-sm font-medium text-text-primary font-mono">
                        {shortenAddress(ps.walletAddress)}
                      </p>
                      <p className="text-xs text-text-muted">{ps.jobCount} jobs</p>
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
                <p className="text-text-muted text-sm">No pending settlements</p>
              </div>
            )}
          </div>
        </Card>

        {/* Settlement History */}
        <Card variant="glass" title="Recent Settlements" className="lg:col-span-2">
          <div className="mt-4 overflow-x-auto">
            {settlements.length > 0 ? (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left text-xs font-medium text-text-muted pb-3 uppercase">Wallet</th>
                    <th className="text-left text-xs font-medium text-text-muted pb-3 uppercase">Amount</th>
                    <th className="text-left text-xs font-medium text-text-muted pb-3 uppercase">Status</th>
                    <th className="text-left text-xs font-medium text-text-muted pb-3 uppercase">Jobs</th>
                    <th className="text-left text-xs font-medium text-text-muted pb-3 uppercase">Date</th>
                    <th className="text-left text-xs font-medium text-text-muted pb-3 uppercase">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {settlements.map((s) => (
                    <tr key={s.id} className="border-b border-border/50 last:border-0 hover:bg-surface-hover/50 transition-colors">
                      <td className="py-4">
                        <Link href={`/settlements/${s.id}`} className="text-sm text-text-primary font-mono hover:text-accent transition-colors">
                          {shortenAddress(s.walletAddress)}
                        </Link>
                      </td>
                      <td className="py-4">
                        <span className="text-sm font-bold text-text-primary">
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
                        <span className="text-sm text-text-muted">{s.jobCount}</span>
                      </td>
                      <td className="py-4">
                        <span className="text-sm text-text-muted">
                          {new Date(s.createdAt).toLocaleDateString()}
                        </span>
                      </td>
                      <td className="py-4">
                        <div className="flex items-center gap-2">
                          <Link
                            href={`/settlements/${s.id}`}
                            className="px-3 py-1.5 text-xs bg-surface-hover hover:bg-border text-text-secondary rounded-lg transition-colors font-medium"
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
            ) : (
              <EmptyState
                icon={<Banknote className="w-8 h-8" />}
                title="No settlements yet"
                description="Completed settlements will appear here"
              />
            )}
          </div>
        </Card>
      </div>

      {/* Settlement Configuration */}
      <Card variant="glass" title="Settlement Configuration" description="Configure automatic settlement schedule">
        <div className="mt-4">
          {!editingConfig ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="p-4 bg-surface/50 rounded-xl border border-border/50">
                  <p className="text-xs text-text-muted uppercase mb-1 font-medium">Settlement Period</p>
                  <p className="text-lg font-bold text-text-primary capitalize">
                    {settlementConfig?.period || 'Weekly'}
                  </p>
                </div>
                <div className="p-4 bg-surface/50 rounded-xl border border-border/50">
                  <p className="text-xs text-text-muted uppercase mb-1 font-medium">Minimum Payout</p>
                  <p className="text-lg font-bold text-text-primary">
                    {formatCurrency(settlementConfig?.minimumPayout || 10)}
                  </p>
                </div>
                {settlementConfig?.period === 'weekly' && settlementConfig.dayOfWeek !== null && (
                  <div className="p-4 bg-surface/50 rounded-xl border border-border/50">
                    <p className="text-xs text-text-muted uppercase mb-1 font-medium">Settlement Day</p>
                    <p className="text-lg font-bold text-text-primary">
                      {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][settlementConfig.dayOfWeek]}
                    </p>
                  </div>
                )}
                {settlementConfig?.period === 'monthly' && settlementConfig.dayOfMonth !== null && (
                  <div className="p-4 bg-surface/50 rounded-xl border border-border/50">
                    <p className="text-xs text-text-muted uppercase mb-1 font-medium">Settlement Day</p>
                    <p className="text-lg font-bold text-text-primary">
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
                  <label className="block text-sm font-medium text-text-primary mb-2">
                    Settlement Period
                  </label>
                  <select
                    value={configForm.period || 'weekly'}
                    onChange={(e) => setConfigForm({ ...configForm, period: e.target.value })}
                    className="w-full px-4 py-3 bg-background border border-border rounded-xl text-text-primary focus:outline-none focus:border-accent"
                  >
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-2">
                    Minimum Payout (USD)
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={configForm.minimumPayout || 10}
                    onChange={(e) => setConfigForm({ ...configForm, minimumPayout: Number(e.target.value) })}
                    className="w-full px-4 py-3 bg-background border border-border rounded-xl text-text-primary focus:outline-none focus:border-accent"
                  />
                </div>
                {configForm.period === 'weekly' && (
                  <div>
                    <label className="block text-sm font-medium text-text-primary mb-2">
                      Day of Week
                    </label>
                    <select
                      value={configForm.dayOfWeek ?? 1}
                      onChange={(e) => setConfigForm({ ...configForm, dayOfWeek: Number(e.target.value) })}
                      className="w-full px-4 py-3 bg-background border border-border rounded-xl text-text-primary focus:outline-none focus:border-accent"
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
                    <label className="block text-sm font-medium text-text-primary mb-2">
                      Day of Month
                    </label>
                    <select
                      value={configForm.dayOfMonth ?? 1}
                      onChange={(e) => setConfigForm({ ...configForm, dayOfMonth: Number(e.target.value) })}
                      className="w-full px-4 py-3 bg-background border border-border rounded-xl text-text-primary focus:outline-none focus:border-accent"
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
                <Button
                  onClick={handleSaveConfig}
                  variant="gradient"
                  size="sm"
                  disabled={savingConfig}
                >
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
        </div>
      </Card>

      {/* Solana Configuration — read-only. Since blocker M1-#7, all
          three fields (RPC URL, payer key, USDC mint) are sourced from
          env vars on the API service, not from the DB. The card just
          surfaces the live state for at-a-glance verification. */}
      <Card variant="glass" title="Solana Payment Configuration" description="Live config (sourced from API env vars)">
        <div className="mt-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-4 bg-surface/50 rounded-xl border border-border/50">
              <p className="text-xs text-text-muted uppercase mb-1 font-medium">RPC Endpoint</p>
              <p className="text-sm text-text-primary">
                {paymentMode?.rpcConfigured ? (
                  <span className="text-accent flex items-center gap-2">
                    <Check className="w-4 h-4" /> Mainnet (env)
                  </span>
                ) : (
                  <span className="text-warning flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4" /> Not configured (using devnet)
                  </span>
                )}
              </p>
            </div>
            <div className="p-4 bg-surface/50 rounded-xl border border-border/50">
              <p className="text-xs text-text-muted uppercase mb-1 font-medium">USDC Mint</p>
              <p className="text-sm text-text-primary">
                <span className="text-accent flex items-center gap-2">
                  <Check className="w-4 h-4" /> Default (mainnet USDC)
                </span>
              </p>
            </div>
            <div className="p-4 bg-surface/50 rounded-xl border border-border/50">
              <p className="text-xs text-text-muted uppercase mb-1 font-medium">Payer Wallet</p>
              <p className="text-sm text-text-primary">
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
          <div className="p-3 bg-surface/30 border border-border/30 rounded-xl flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-text-muted flex-shrink-0 mt-0.5" />
            <p className="text-xs text-text-muted leading-relaxed">
              These values are read from <code className="text-text-secondary">SOLANA_PAYER_KEY</code>, <code className="text-text-secondary">SOLANA_RPC_URL</code>, and <code className="text-text-secondary">SOLANA_USDC_MINT</code> on the API service. To change them, edit Render&apos;s Environment tab and redeploy. The boot log&apos;s <code className="text-text-secondary">[solana]</code> lines confirm which source each field came from.
            </p>
          </div>
          {!paymentMode?.devMode && (
            <p className="text-xs text-accent font-medium">Live payments enabled</p>
          )}
        </div>
      </Card>

      {/* Activity Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total Jobs" value={summary?.activity.totalJobs ?? 0} icon={<Briefcase className="w-4 h-4" />} />
        <StatCard label="GPU Hours" value={(summary?.revenue.gpuHours ?? 0).toFixed(1)} icon={<Clock className="w-4 h-4" />} />
        <StatCard label="Completed Settlements" value={summary?.settlements.completed ?? 0} variant="accent" icon={<Check className="w-4 h-4" />} />
        <StatCard
          label="Settled Amount"
          value={formatCurrency(summary?.settlements.amount ?? 0)}
          variant="accent"
          icon={<Banknote className="w-4 h-4" />}
        />
      </div>

      {/* Export Section */}
      <Card variant="glass" title="Export Reports" description="Download data as CSV files">
        <div className="flex flex-wrap gap-3 mt-4">
          <Button
            onClick={() => api.reports.downloadCSV('earnings')}
            variant="secondary"
            size="sm"
            icon={<Download className="w-4 h-4" />}
          >
            Earnings CSV
          </Button>
          <Button
            onClick={() => api.reports.downloadCSV('settlements')}
            variant="secondary"
            size="sm"
            icon={<Download className="w-4 h-4" />}
          >
            Settlements CSV
          </Button>
          <Button
            onClick={() => api.reports.downloadCSV('jobs')}
            variant="secondary"
            size="sm"
            icon={<Download className="w-4 h-4" />}
          >
            Jobs CSV
          </Button>
          <Button
            onClick={() => api.reports.downloadCSV('nodes')}
            variant="secondary"
            size="sm"
            icon={<Download className="w-4 h-4" />}
          >
            Nodes CSV
          </Button>
        </div>
      </Card>
    </motion.div>
  )
}

// Empty State Component
function EmptyState({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode
  title: string
  description: string
}) {
  return (
    <div className="py-12 text-center">
      <div className="w-14 h-14 rounded-2xl bg-surface-hover flex items-center justify-center mx-auto mb-4 text-text-muted">
        {icon}
      </div>
      <h3 className="text-sm font-medium text-text-primary mb-1">{title}</h3>
      <p className="text-xs text-text-muted">{description}</p>
    </div>
  )
}

// Icons
function DollarIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

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

function TestTubeIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
    </svg>
  )
}

function ShieldCheckIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
    </svg>
  )
}

function TrendingUpIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
    </svg>
  )
}

function TrendingDownIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 17h8m0 0V9m0 8l-8-8-4 4-6-6" />
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

function ReceiptIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" />
    </svg>
  )
}

function CheckIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  )
}

function BankIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 14v3m4-3v3m4-3v3M3 21h18M3 10h18M3 7l9-4 9 4M4 10h16v11H4V10z" />
    </svg>
  )
}

function EditIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
    </svg>
  )
}

function BriefcaseIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  )
}

function ClockIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function DownloadIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
    </svg>
  )
}
