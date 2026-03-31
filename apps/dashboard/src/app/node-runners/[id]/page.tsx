'use client'

import { useState, useEffect, use } from 'react'
import Link from 'next/link'
import { api } from '@/lib/api'

interface NodeRunnerDetail {
  id: string
  name: string
  email: string | null
  walletAddress: string
  createdAt: string
  financials: {
    totalInvested: number
    totalEarnings: number
    totalPayouts: number
    pendingPayout: number
    netPosition: number
    roiPercentage: number
  }
  nodes: Array<{
    id: string
    gpuTier: string
    status: string
    createdAt: string
  }>
  nodeEarnings: Array<{
    nodeId: string
    gpuTier: string
    uptimeHours: number
    earnings: number
  }>
  investments: Array<{
    id: string
    amount: number
    currency: string
    cryptoAmount: number | null
    cryptoCurrency: string | null
    txHash: string | null
    gpuTier: string
    status: string
    createdAt: string
    confirmedAt: string | null
    provisionedAt: string | null
  }>
}

interface ROIData {
  period: { days: number; start: string | null; end: string | null }
  summary: {
    totalInvested: number
    totalEarnings: number
    totalUptimeHours: number
    avgDailyEarnings: number
    roiPercentage: number
  }
  projections: {
    daysToBreakeven: number | null
    projectedMonthlyEarnings: number
    projectedYearlyEarnings: number
  }
  daily: Array<{ date: string; uptimeHours: number; earnings: number }>
}

export default function NodeRunnerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params)
  const [runner, setRunner] = useState<NodeRunnerDetail | null>(null)
  const [roi, setRoi] = useState<ROIData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [roiDays, setRoiDays] = useState(30)

  useEffect(() => {
    loadData()
  }, [resolvedParams.id, roiDays])

  async function loadData() {
    try {
      setLoading(true)
      const [runnerData, roiData] = await Promise.all([
        api.nodeRunners.get(resolvedParams.id),
        api.nodeRunners.roi(resolvedParams.id, { days: roiDays }),
      ])
      setRunner(runnerData)
      setRoi(roiData)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data')
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" />
      </div>
    )
  }

  if (error || !runner) {
    return (
      <div className="bg-error/10 border border-error/20 text-error px-4 py-3 rounded-lg">
        {error || 'Node runner not found'}
      </div>
    )
  }

  const fin = runner.financials

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link
            href="/node-runners"
            className="p-2 hover:bg-surface-hover rounded-lg transition-colors"
          >
            <ArrowLeftIcon className="w-5 h-5 text-text-muted" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">{runner.name}</h1>
            <p className="text-text-muted mt-1">
              Member since {new Date(runner.createdAt).toLocaleDateString()}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <code className="text-sm text-text-secondary bg-surface px-3 py-1.5 rounded-lg border border-border">
            {runner.walletAddress.slice(0, 12)}...{runner.walletAddress.slice(-8)}
          </code>
        </div>
      </div>

      {/* Financial Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <div className="bg-surface border border-border rounded-xl p-4">
          <p className="text-text-muted text-sm">Total Invested</p>
          <p className="text-2xl font-bold text-text-primary mt-1">
            ${fin.totalInvested.toLocaleString()}
          </p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <p className="text-text-muted text-sm">Total Earnings</p>
          <p className="text-2xl font-bold text-accent mt-1">
            ${fin.totalEarnings.toLocaleString()}
          </p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <p className="text-text-muted text-sm">Total Payouts</p>
          <p className="text-2xl font-bold text-text-primary mt-1">
            ${fin.totalPayouts.toLocaleString()}
          </p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <p className="text-text-muted text-sm">Pending Payout</p>
          <p className="text-2xl font-bold text-warning mt-1">
            ${fin.pendingPayout.toLocaleString()}
          </p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <p className="text-text-muted text-sm">Net Position</p>
          <p className={`text-2xl font-bold mt-1 ${fin.netPosition >= 0 ? 'text-accent' : 'text-error'}`}>
            {fin.netPosition >= 0 ? '+' : ''}${fin.netPosition.toLocaleString()}
          </p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <p className="text-text-muted text-sm">ROI</p>
          <p className={`text-2xl font-bold mt-1 ${fin.roiPercentage >= 0 ? 'text-accent' : 'text-error'}`}>
            {fin.roiPercentage >= 0 ? '+' : ''}{fin.roiPercentage.toFixed(1)}%
          </p>
        </div>
      </div>

      {/* ROI Projections */}
      {roi && (
        <div className="bg-surface border border-border rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-text-primary">ROI Projections</h2>
            <select
              value={roiDays}
              onChange={(e) => setRoiDays(Number(e.target.value))}
              className="px-3 py-1.5 bg-background border border-border rounded-lg text-text-primary text-sm"
            >
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-background rounded-lg p-4">
              <p className="text-text-muted text-sm">Avg Daily Earnings</p>
              <p className="text-xl font-bold text-text-primary mt-1">
                ${roi.summary.avgDailyEarnings.toFixed(2)}
              </p>
            </div>
            <div className="bg-background rounded-lg p-4">
              <p className="text-text-muted text-sm">Days to Breakeven</p>
              <p className="text-xl font-bold text-text-primary mt-1">
                {roi.projections.daysToBreakeven
                  ? `${roi.projections.daysToBreakeven} days`
                  : fin.netPosition >= 0 ? 'Achieved!' : 'N/A'}
              </p>
            </div>
            <div className="bg-background rounded-lg p-4">
              <p className="text-text-muted text-sm">Projected Monthly</p>
              <p className="text-xl font-bold text-accent mt-1">
                ${roi.projections.projectedMonthlyEarnings.toLocaleString()}
              </p>
            </div>
            <div className="bg-background rounded-lg p-4">
              <p className="text-text-muted text-sm">Projected Yearly</p>
              <p className="text-xl font-bold text-accent mt-1">
                ${roi.projections.projectedYearlyEarnings.toLocaleString()}
              </p>
            </div>
          </div>

          {/* Daily Earnings Chart (Simple Bar Representation) */}
          {roi.daily.length > 0 && (
            <div className="mt-6">
              <h3 className="text-sm font-medium text-text-secondary mb-3">Daily Earnings</h3>
              <div className="flex items-end gap-1 h-32">
                {roi.daily.slice(-14).map((day, i) => {
                  const maxEarnings = Math.max(...roi.daily.map(d => d.earnings))
                  const height = maxEarnings > 0 ? (day.earnings / maxEarnings) * 100 : 0
                  return (
                    <div
                      key={i}
                      className="flex-1 bg-accent/20 hover:bg-accent/40 rounded-t transition-colors relative group"
                      style={{ height: `${Math.max(height, 4)}%` }}
                    >
                      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-surface border border-border rounded text-xs text-text-primary opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-10">
                        ${day.earnings.toFixed(2)}
                        <br />
                        <span className="text-text-muted">{day.date}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Nodes */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">Nodes ({runner.nodes.length})</h2>
        </div>
        <table className="w-full">
          <thead className="bg-surface-hover">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">Node ID</th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">GPU Tier</th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">Status</th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">Uptime Hours</th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">Earnings</th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {runner.nodes.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-6 py-8 text-center text-text-muted">
                  No nodes provisioned yet
                </td>
              </tr>
            ) : (
              runner.nodes.map((node) => {
                const nodeEarning = runner.nodeEarnings.find(ne => ne.nodeId === node.id)
                return (
                  <tr key={node.id} className="hover:bg-surface-hover transition-colors">
                    <td className="px-6 py-4">
                      <Link href={`/nodes/${node.id}`} className="text-accent hover:underline font-mono text-sm">
                        {node.id.slice(0, 12)}...
                      </Link>
                    </td>
                    <td className="px-6 py-4">
                      <span className="px-2 py-1 bg-accent/10 text-accent rounded text-sm font-medium">
                        {node.gpuTier}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium ${
                        node.status === 'ONLINE'
                          ? 'bg-accent/10 text-accent'
                          : node.status === 'DEGRADED'
                          ? 'bg-warning/10 text-warning'
                          : 'bg-error/10 text-error'
                      }`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${
                          node.status === 'ONLINE' ? 'bg-accent' : node.status === 'DEGRADED' ? 'bg-warning' : 'bg-error'
                        }`} />
                        {node.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-text-primary">
                      {nodeEarning ? `${nodeEarning.uptimeHours.toFixed(1)}h` : '-'}
                    </td>
                    <td className="px-6 py-4 text-accent font-medium">
                      {nodeEarning ? `$${nodeEarning.earnings.toFixed(2)}` : '-'}
                    </td>
                    <td className="px-6 py-4 text-text-muted text-sm">
                      {new Date(node.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Investment History */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">Investment History</h2>
        </div>
        <table className="w-full">
          <thead className="bg-surface-hover">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">Date</th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">Amount</th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">GPU Tier</th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">Status</th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">TX Hash</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {runner.investments.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-6 py-8 text-center text-text-muted">
                  No investments recorded
                </td>
              </tr>
            ) : (
              runner.investments.map((inv) => (
                <tr key={inv.id} className="hover:bg-surface-hover transition-colors">
                  <td className="px-6 py-4 text-text-muted text-sm">
                    {new Date(inv.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4">
                    <span className="text-text-primary font-medium">
                      ${inv.amount.toLocaleString()}
                    </span>
                    {inv.cryptoAmount && (
                      <span className="text-text-muted text-sm ml-2">
                        ({inv.cryptoAmount} {inv.cryptoCurrency})
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    <span className="px-2 py-1 bg-accent/10 text-accent rounded text-sm">
                      {inv.gpuTier}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                      inv.status === 'PROVISIONED'
                        ? 'bg-accent/10 text-accent'
                        : inv.status === 'PAID'
                        ? 'bg-warning/10 text-warning'
                        : inv.status === 'PENDING'
                        ? 'bg-text-muted/10 text-text-muted'
                        : 'bg-error/10 text-error'
                    }`}>
                      {inv.status}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    {inv.txHash ? (
                      <a
                        href={`https://solscan.io/tx/${inv.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent hover:underline font-mono text-sm"
                      >
                        {inv.txHash.slice(0, 8)}...{inv.txHash.slice(-6)}
                      </a>
                    ) : (
                      <span className="text-text-muted">-</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ArrowLeftIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
    </svg>
  )
}
