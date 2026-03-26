'use client'

import { useEffect, useState } from 'react'
import { Card, StatCard } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { api } from '@/lib/api'

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
}

export default function FinancialPage() {
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

  useEffect(() => {
    loadData()
  }, [days])

  async function loadData() {
    setLoading(true)
    try {
      const [summaryData, earningsData, costsData, settlementsData, pendingData, modeData] = await Promise.all([
        api.reports.summary({ days }),
        api.earnings.byMarket({ days }),
        api.costs.summary({ days }),
        api.settlements.list({ limit: 10 }),
        api.settlements.pending(),
        api.payments.mode(),
      ])

      setSummary(summaryData)
      setEarningsByMarket(earningsData)
      setCostsSummary(costsData)
      setSettlements(settlementsData.settlements)
      setPendingSettlements(pendingData.pending)
      setPendingTotal(pendingData.totalAmount)
      setPaymentMode(modeData)
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
      alert(`Created ${result.settlementIds.length} settlement(s)`)
      loadData()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to trigger settlements')
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
      alert(result.isDevMode
        ? `DEV MODE: Payment simulated!\nTx: ${result.txHash.substring(0, 20)}...`
        : `Payment sent!\nTx: ${result.txHash}`)
      loadData()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to process payment')
    } finally {
      setProcessingPayment(null)
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-text-muted">Loading financial data...</div>
      </div>
    )
  }

  if (error) {
    return (
      <Card className="border-error">
        <p className="text-error">Error: {error}</p>
        <Button onClick={loadData} variant="outline" className="mt-4">
          Retry
        </Button>
      </Card>
    )
  }

  return (
    <div className="space-y-8">
      {/* Payment Mode Banner */}
      {paymentMode && (
        <div className={`p-4 rounded-lg border ${
          paymentMode.devMode
            ? 'bg-warning/10 border-warning/30'
            : 'bg-accent/10 border-accent/30'
        }`}>
          <div className="flex items-center gap-3">
            <span className={`px-3 py-1 rounded-full text-sm font-bold ${
              paymentMode.devMode
                ? 'bg-warning/20 text-warning'
                : 'bg-accent/20 text-accent'
            }`}>
              {paymentMode.mode.toUpperCase()} MODE
            </span>
            <span className={paymentMode.devMode ? 'text-warning' : 'text-accent'}>
              {paymentMode.description}
            </span>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Financial Overview</h1>
          <p className="text-text-muted mt-1">
            Revenue, costs, and settlement tracking
          </p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <Button onClick={loadData} variant="outline" size="sm">
            Refresh
          </Button>
        </div>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Total Revenue"
          value={formatCurrency(summary?.revenue.total ?? 0)}
        />
        <StatCard
          label="Total Costs"
          value={formatCurrency(summary?.costs.total ?? 0)}
        />
        <StatCard
          label="Gross Profit"
          value={formatCurrency(summary?.profit.gross ?? 0)}
          className={summary?.profit.gross && summary.profit.gross > 0 ? 'border-accent' : 'border-error'}
        />
        <StatCard
          label="Profit Margin"
          value={formatPercent(summary?.profit.margin ?? 0)}
        />
      </div>

      {/* Revenue and Costs Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Revenue by Market */}
        <Card title="Revenue by Market">
          <div className="space-y-4 mt-4">
            {earningsByMarket && Object.keys(earningsByMarket.byMarket).length > 0 ? (
              Object.entries(earningsByMarket.byMarket).map(([market, data]) => {
                const total = earningsByMarket.total.earnings
                const percentage = total > 0 ? (data.earnings / total) * 100 : 0
                return (
                  <div key={market}>
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`w-3 h-3 rounded-full ${
                            market === 'INTERNAL'
                              ? 'bg-accent'
                              : market === 'AKASH'
                              ? 'bg-blue-500'
                              : 'bg-purple-500'
                          }`}
                        />
                        <span className="text-sm text-text-primary">{market}</span>
                      </div>
                      <span className="text-sm font-medium text-text-primary">
                        {formatCurrency(data.earnings)}
                      </span>
                    </div>
                    <div className="h-2 bg-background rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          market === 'INTERNAL'
                            ? 'bg-accent'
                            : market === 'AKASH'
                            ? 'bg-blue-500'
                            : 'bg-purple-500'
                        }`}
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                    <div className="flex justify-between mt-1">
                      <span className="text-xs text-text-muted">
                        {data.gpuHours.toFixed(1)} GPU hours
                      </span>
                      <span className="text-xs text-text-muted">{data.jobCount} jobs</span>
                    </div>
                  </div>
                )
              })
            ) : (
              <p className="text-text-muted text-sm text-center py-4">
                No revenue recorded in this period
              </p>
            )}
            <div className="pt-4 border-t border-border">
              <div className="flex justify-between">
                <span className="text-sm font-medium text-text-primary">Total</span>
                <span className="text-sm font-bold text-accent">
                  {formatCurrency(earningsByMarket?.total.earnings ?? 0)}
                </span>
              </div>
            </div>
          </div>
        </Card>

        {/* Costs by Category */}
        <Card title="Costs by Category">
          <div className="space-y-4 mt-4">
            {costsSummary && costsSummary.total > 0 ? (
              Object.entries(costsSummary.byCategory)
                .filter(([, amount]) => amount > 0)
                .map(([category, amount]) => {
                  const percentage = (amount / costsSummary.total) * 100
                  const colors: Record<string, string> = {
                    HOSTING: 'bg-red-500',
                    POWER: 'bg-yellow-500',
                    NETWORK: 'bg-blue-500',
                    OTHER: 'bg-gray-500',
                  }
                  return (
                    <div key={category}>
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          <span className={`w-3 h-3 rounded-full ${colors[category] ?? 'bg-gray-500'}`} />
                          <span className="text-sm text-text-primary">{category}</span>
                        </div>
                        <span className="text-sm font-medium text-text-primary">
                          {formatCurrency(amount)}
                        </span>
                      </div>
                      <div className="h-2 bg-background rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${colors[category] ?? 'bg-gray-500'}`}
                          style={{ width: `${percentage}%` }}
                        />
                      </div>
                    </div>
                  )
                })
            ) : (
              <p className="text-text-muted text-sm text-center py-4">No costs recorded in this period</p>
            )}
            <div className="pt-4 border-t border-border">
              <div className="flex justify-between">
                <span className="text-sm font-medium text-text-primary">Total Costs</span>
                <span className="text-sm font-bold text-error">
                  {formatCurrency(costsSummary?.total ?? 0)}
                </span>
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* Settlements Section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Pending Settlements */}
        <Card title="Pending Settlements" className="lg:col-span-1">
          <div className="mt-4">
            <div className="flex items-center justify-between mb-4 p-3 bg-warning/10 border border-warning/20 rounded-lg">
              <div>
                <p className="text-sm font-medium text-text-primary">Ready to Settle</p>
                <p className="text-2xl font-bold text-warning">{formatCurrency(pendingTotal)}</p>
              </div>
              <Button
                onClick={handleTriggerSettlements}
                variant="primary"
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
                    className="flex items-center justify-between p-2 bg-surface-hover rounded-lg"
                  >
                    <div>
                      <p className="text-sm font-medium text-text-primary">
                        {shortenAddress(ps.walletAddress)}
                      </p>
                      <p className="text-xs text-text-muted">{ps.jobCount} jobs</p>
                    </div>
                    <span className="text-sm font-medium text-accent">
                      {formatCurrency(ps.amount)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-text-muted text-sm text-center py-4">
                No pending settlements
              </p>
            )}
          </div>
        </Card>

        {/* Settlement History */}
        <Card title="Recent Settlements" className="lg:col-span-2">
          <div className="mt-4 overflow-x-auto">
            {settlements.length > 0 ? (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left text-xs font-medium text-text-muted pb-2">Wallet</th>
                    <th className="text-left text-xs font-medium text-text-muted pb-2">Amount</th>
                    <th className="text-left text-xs font-medium text-text-muted pb-2">Status</th>
                    <th className="text-left text-xs font-medium text-text-muted pb-2">Jobs</th>
                    <th className="text-left text-xs font-medium text-text-muted pb-2">Date</th>
                    <th className="text-left text-xs font-medium text-text-muted pb-2">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {settlements.map((s) => (
                    <tr key={s.id} className="border-b border-border/50 last:border-0">
                      <td className="py-3">
                        <span className="text-sm text-text-primary font-mono">
                          {shortenAddress(s.walletAddress)}
                        </span>
                      </td>
                      <td className="py-3">
                        <span className="text-sm font-medium text-text-primary">
                          {formatCurrency(s.amount)}
                        </span>
                      </td>
                      <td className="py-3">
                        <span
                          className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full ${
                            s.status === 'COMPLETED'
                              ? 'bg-accent/10 text-accent'
                              : s.status === 'PENDING'
                              ? 'bg-warning/10 text-warning'
                              : s.status === 'PROCESSING'
                              ? 'bg-blue-500/10 text-blue-500'
                              : 'bg-error/10 text-error'
                          }`}
                        >
                          {s.status}
                        </span>
                      </td>
                      <td className="py-3">
                        <span className="text-sm text-text-muted">{s.jobCount}</span>
                      </td>
                      <td className="py-3">
                        <span className="text-sm text-text-muted">
                          {new Date(s.createdAt).toLocaleDateString()}
                        </span>
                      </td>
                      <td className="py-3">
                        {s.status === 'PENDING' ? (
                          <button
                            onClick={() => handleProcessPayment(s.id)}
                            disabled={processingPayment === s.id}
                            className="px-3 py-1 bg-accent hover:bg-accent/80 disabled:bg-accent/50 text-white text-xs font-medium rounded transition-colors"
                          >
                            {processingPayment === s.id ? 'Paying...' : 'Pay'}
                          </button>
                        ) : s.status === 'COMPLETED' && s.txHash ? (
                          <span className="text-xs text-text-muted font-mono">
                            {s.txHash.substring(0, 12)}...
                          </span>
                        ) : (
                          <span className="text-xs text-text-muted">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-text-muted text-sm text-center py-8">No settlements yet</p>
            )}
          </div>
        </Card>
      </div>

      {/* Activity Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total Jobs" value={summary?.activity.totalJobs ?? 0} />
        <StatCard label="GPU Hours" value={(summary?.revenue.gpuHours ?? 0).toFixed(1)} />
        <StatCard label="Completed Settlements" value={summary?.settlements.completed ?? 0} />
        <StatCard
          label="Settled Amount"
          value={formatCurrency(summary?.settlements.amount ?? 0)}
        />
      </div>

      {/* Export Section */}
      <Card title="Export Reports">
        <div className="flex flex-wrap gap-3 mt-4">
          <button
            onClick={() => api.reports.downloadCSV('earnings')}
            className="px-4 py-2 bg-surface-hover hover:bg-border rounded-lg text-sm font-medium text-text-primary transition-colors"
          >
            Export Earnings CSV
          </button>
          <button
            onClick={() => api.reports.downloadCSV('settlements')}
            className="px-4 py-2 bg-surface-hover hover:bg-border rounded-lg text-sm font-medium text-text-primary transition-colors"
          >
            Export Settlements CSV
          </button>
          <button
            onClick={() => api.reports.downloadCSV('jobs')}
            className="px-4 py-2 bg-surface-hover hover:bg-border rounded-lg text-sm font-medium text-text-primary transition-colors"
          >
            Export Jobs CSV
          </button>
          <button
            onClick={() => api.reports.downloadCSV('nodes')}
            className="px-4 py-2 bg-surface-hover hover:bg-border rounded-lg text-sm font-medium text-text-primary transition-colors"
          >
            Export Nodes CSV
          </button>
        </div>
      </Card>
    </div>
  )
}
