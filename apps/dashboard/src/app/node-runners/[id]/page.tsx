'use client'

import { useState, useEffect, use } from 'react'
import Link from 'next/link'
import { ArrowLeft, Plus, DollarSign, TrendingUp, Wallet, BarChart3, Server, Users, Activity } from 'lucide-react'
import { api } from '@/lib/api'
import { Modal } from '@/components/ui/Modal'
import {
  DashboardShell,
  DashboardMainColumn,
  DashboardRightRail,
  SectionCard,
  MetricTriad,
} from '@/components/dashboard/FuturisticShell'

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
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [roiDays, setRoiDays] = useState(30)

  const [showInvestmentModal, setShowInvestmentModal] = useState(false)
  const [newInvestment, setNewInvestment] = useState({ amount: '', gpuTier: 'H100', txHash: '' })
  const [creatingInvestment, setCreatingInvestment] = useState(false)

  useEffect(() => {
    loadData()
  }, [resolvedParams.id, roiDays])

  async function loadData(isRefresh = false) {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    try {
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
      setRefreshing(false)
    }
  }

  async function handleCreateInvestment(e: React.FormEvent) {
    e.preventDefault()
    if (!runner) return

    try {
      setCreatingInvestment(true)
      await api.investments.create({
        nodeRunnerId: runner.id,
        amount: parseFloat(newInvestment.amount),
        gpuTier: newInvestment.gpuTier,
        txHash: newInvestment.txHash || undefined,
      })
      setShowInvestmentModal(false)
      setNewInvestment({ amount: '', gpuTier: 'H100', txHash: '' })
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create investment')
    } finally {
      setCreatingInvestment(false)
    }
  }

  if (loading || !runner) {
    return (
      <DashboardShell title="Node Runner" subtitle="Loading...">
        <div className="lg:col-span-3">
          <SectionCard>
            <p className="text-sm py-8 text-center" style={{ color: 'var(--text-muted)' }}>
              {error || 'Loading...'}
            </p>
          </SectionCard>
        </div>
      </DashboardShell>
    )
  }

  const fin = runner.financials

  return (
    <DashboardShell
      title={runner.name}
      subtitle={runner.id.slice(0, 12)}
      onRefresh={() => loadData(true)}
      refreshing={refreshing}
    >
      <DashboardMainColumn>
        <Link href="/node-runners" className="inline-flex items-center gap-1.5 text-sm hover:text-accent transition-colors -mt-2" style={{ color: 'var(--text-muted)' }}>
          <ArrowLeft size={16} />
          Back to Node Runners
        </Link>

        <div className="flex items-center justify-end">
          <button
            onClick={() => setShowInvestmentModal(true)}
            className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg font-medium transition-colors flex items-center gap-2 text-sm"
          >
            <Plus size={16} />
            Add Investment
          </button>
        </div>

        <MetricTriad
          metrics={[
            {
              label: 'Total Invested',
              value: `$${fin.totalInvested.toLocaleString()}`,
              icon: DollarSign,
              tone: 'green',
            },
            {
              label: 'Total Earnings',
              value: `$${fin.totalEarnings.toLocaleString()}`,
              detail: `${fin.netPosition >= 0 ? '+' : ''}$${fin.netPosition.toLocaleString()} net`,
              icon: TrendingUp,
              tone: 'blue',
            },
            {
              label: 'ROI',
              value: `${fin.roiPercentage >= 0 ? '+' : ''}${fin.roiPercentage.toFixed(1)}%`,
              detail: `$${fin.pendingPayout.toFixed(2)} pending`,
              icon: BarChart3,
              tone: 'purple',
            },
          ]}
        />

        {roi && (
          <SectionCard title="ROI Projections" icon={TrendingUp} actions={
            <select
              value={roiDays}
              onChange={(e) => setRoiDays(Number(e.target.value))}
              className="px-3 py-1.5 bg-background border border-border rounded-lg text-sm"
              style={{ color: 'var(--text-primary)' }}
            >
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
          }>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="bg-background rounded-lg p-4">
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Avg Daily Earnings</p>
                <p className="text-xl font-bold mt-1" style={{ color: 'var(--text-primary)' }}>
                  ${roi.summary.avgDailyEarnings.toFixed(2)}
                </p>
              </div>
              <div className="bg-background rounded-lg p-4">
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Days to Breakeven</p>
                <p className="text-xl font-bold mt-1" style={{ color: 'var(--text-primary)' }}>
                  {roi.projections.daysToBreakeven
                    ? `${roi.projections.daysToBreakeven} days`
                    : fin.netPosition >= 0 ? 'Achieved!' : 'N/A'}
                </p>
              </div>
              <div className="bg-background rounded-lg p-4">
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Projected Monthly</p>
                <p className="text-xl font-bold text-accent mt-1">
                  ${roi.projections.projectedMonthlyEarnings.toLocaleString()}
                </p>
              </div>
              <div className="bg-background rounded-lg p-4">
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Projected Yearly</p>
                <p className="text-xl font-bold text-accent mt-1">
                  ${roi.projections.projectedYearlyEarnings.toLocaleString()}
                </p>
              </div>
            </div>

            {roi.daily.length > 0 && (
              <div className="mt-6">
                <h3 className="text-sm font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>Daily Earnings</h3>
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
                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-surface border border-border rounded text-xs opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-10" style={{ color: 'var(--text-primary)' }}>
                          ${day.earnings.toFixed(2)}
                          <br />
                          <span style={{ color: 'var(--text-muted)' }}>{day.date}</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </SectionCard>
        )}

        <SectionCard title={`Nodes (${runner.nodes.length})`} icon={Server}>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-surface-hover">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase" style={{ color: 'var(--text-muted)' }}>Node ID</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase" style={{ color: 'var(--text-muted)' }}>GPU Tier</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase" style={{ color: 'var(--text-muted)' }}>Status</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase" style={{ color: 'var(--text-muted)' }}>Uptime</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase" style={{ color: 'var(--text-muted)' }}>Earnings</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase" style={{ color: 'var(--text-muted)' }}>Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {runner.nodes.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center" style={{ color: 'var(--text-muted)' }}>
                      No nodes provisioned yet
                    </td>
                  </tr>
                ) : (
                  runner.nodes.map((node) => {
                    const nodeEarning = runner.nodeEarnings.find(ne => ne.nodeId === node.id)
                    return (
                      <tr key={node.id} className="hover:bg-surface-hover transition-colors">
                        <td className="px-4 py-4">
                          <Link href={`/nodes/${node.id}`} className="text-accent hover:underline font-mono text-sm">
                            {node.id.slice(0, 12)}...
                          </Link>
                        </td>
                        <td className="px-4 py-4">
                          <span className="px-2 py-1 bg-accent/10 text-accent rounded text-sm font-medium">
                            {node.gpuTier}
                          </span>
                        </td>
                        <td className="px-4 py-4">
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
                        <td className="px-4 py-4" style={{ color: 'var(--text-primary)' }}>
                          {nodeEarning ? `${nodeEarning.uptimeHours.toFixed(1)}h` : '-'}
                        </td>
                        <td className="px-4 py-4 text-accent font-medium">
                          {nodeEarning ? `$${nodeEarning.earnings.toFixed(2)}` : '-'}
                        </td>
                        <td className="px-4 py-4 text-sm" style={{ color: 'var(--text-muted)' }}>
                          {new Date(node.createdAt).toLocaleDateString()}
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </SectionCard>

        <SectionCard title="Investment History" icon={DollarSign} actions={
          <button
            onClick={() => setShowInvestmentModal(true)}
            className="text-sm text-accent hover:text-accent-hover"
          >
            + Add Investment
          </button>
        }>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-surface-hover">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase" style={{ color: 'var(--text-muted)' }}>Date</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase" style={{ color: 'var(--text-muted)' }}>Amount</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase" style={{ color: 'var(--text-muted)' }}>GPU Tier</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase" style={{ color: 'var(--text-muted)' }}>Status</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase" style={{ color: 'var(--text-muted)' }}>TX Hash</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {runner.investments.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center" style={{ color: 'var(--text-muted)' }}>
                      No investments recorded
                    </td>
                  </tr>
                ) : (
                  runner.investments.map((inv) => (
                    <tr key={inv.id} className="hover:bg-surface-hover transition-colors">
                      <td className="px-4 py-4 text-sm" style={{ color: 'var(--text-muted)' }}>
                        {new Date(inv.createdAt).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-4">
                        <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                          ${inv.amount.toLocaleString()}
                        </span>
                        {inv.cryptoAmount && (
                          <span className="text-sm ml-2" style={{ color: 'var(--text-muted)' }}>
                            ({inv.cryptoAmount} {inv.cryptoCurrency})
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-4">
                        <span className="px-2 py-1 bg-accent/10 text-accent rounded text-sm">
                          {inv.gpuTier}
                        </span>
                      </td>
                      <td className="px-4 py-4">
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
                      <td className="px-4 py-4">
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
                          <span style={{ color: 'var(--text-muted)' }}>-</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </SectionCard>
      </DashboardMainColumn>

      <DashboardRightRail>
        <SectionCard title="Profile" icon={Users}>
          <dl className="space-y-3">
            <div className="flex justify-between">
              <dt className="text-sm" style={{ color: 'var(--text-muted)' }}>Name</dt>
              <dd className="text-sm" style={{ color: 'var(--text-primary)' }}>{runner.name}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm" style={{ color: 'var(--text-muted)' }}>Email</dt>
              <dd className="text-sm" style={{ color: 'var(--text-primary)' }}>{runner.email || '-'}</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-sm mb-1" style={{ color: 'var(--text-muted)' }}>Wallet</dt>
              <dd className="text-xs font-mono break-all" style={{ color: 'var(--text-primary)' }}>{runner.walletAddress}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm" style={{ color: 'var(--text-muted)' }}>Joined</dt>
              <dd className="text-sm" style={{ color: 'var(--text-primary)' }}>{new Date(runner.createdAt).toLocaleDateString()}</dd>
            </div>
          </dl>
        </SectionCard>

        <SectionCard title="Quick Stats" icon={Activity}>
          <div className="space-y-3">
            <div className="flex justify-between items-baseline">
              <span className="font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-muted)' }}>Nodes</span>
              <span className="font-display text-sm" style={{ color: 'var(--text-primary)' }}>{runner.nodes.length}</span>
            </div>
            <div className="flex justify-between items-baseline">
              <span className="font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-muted)' }}>Investments</span>
              <span className="font-display text-sm" style={{ color: 'var(--text-primary)' }}>{runner.investments.length}</span>
            </div>
            <div className="flex justify-between items-baseline">
              <span className="font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-muted)' }}>Pending Payout</span>
              <span className="font-display text-sm" style={{ color: 'var(--text-primary)' }}>${fin.pendingPayout.toFixed(2)}</span>
            </div>
            <div className="flex justify-between items-baseline">
              <span className="font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-muted)' }}>Total Payouts</span>
              <span className="font-display text-sm" style={{ color: 'var(--text-primary)' }}>${fin.totalPayouts.toFixed(2)}</span>
            </div>
          </div>
        </SectionCard>
      </DashboardRightRail>

      <Modal
        isOpen={showInvestmentModal}
        onClose={() => setShowInvestmentModal(false)}
        title="Add Investment"
      >
        <form onSubmit={handleCreateInvestment} className="space-y-4">
          <p style={{ color: 'var(--text-muted)' }}>
            Add a new investment for{' '}
            <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{runner.name}</span>
          </p>
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
              Amount (USD) *
            </label>
            <input
              type="number"
              step="0.01"
              value={newInvestment.amount}
              onChange={(e) => setNewInvestment({ ...newInvestment, amount: e.target.value })}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-accent"
              style={{ color: 'var(--text-primary)' }}
              placeholder="2500"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
              GPU Tier *
            </label>
            <select
              value={newInvestment.gpuTier}
              onChange={(e) => setNewInvestment({ ...newInvestment, gpuTier: e.target.value })}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-accent"
              style={{ color: 'var(--text-primary)' }}
            >
              <option value="H100">H100</option>
              <option value="H200">H200</option>
              <option value="B200">B200</option>
              <option value="B300">B300</option>
              <option value="GB300">GB300</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
              Transaction Hash (optional)
            </label>
            <input
              type="text"
              value={newInvestment.txHash}
              onChange={(e) => setNewInvestment({ ...newInvestment, txHash: e.target.value })}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              style={{ color: 'var(--text-primary)' }}
              placeholder="Leave empty for pending payment"
            />
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              If provided, investment will be marked as PAID immediately
            </p>
          </div>
          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={() => setShowInvestmentModal(false)}
              className="px-4 py-2 transition-colors"
              style={{ color: 'var(--text-secondary)' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={creatingInvestment}
              className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg font-medium transition-colors disabled:opacity-50"
            >
              {creatingInvestment ? 'Creating...' : 'Create Investment'}
            </button>
          </div>
        </form>
      </Modal>
    </DashboardShell>
  )
}
