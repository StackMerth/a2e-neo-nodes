'use client'

import { useEffect, useState, useCallback } from 'react'
import { Receipt, Plus, DollarSign, FolderOpen, TrendingUp, List, AlertTriangle, X, Check, Zap, Server as ServerIcon, Wrench, TrendingDown, Globe, MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input, Select } from '@/components/ui/Input'
import { Modal, ConfirmModal } from '@/components/ui/Modal'
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

interface Cost {
  id: string
  nodeId: string | null
  category: string
  amount: number
  currency: string
  description: string | null
  periodStart: string
  periodEnd: string
  createdAt: string
}

interface CostSummary {
  period: { start: string; end: string }
  total: number
  byCategory: Record<string, number>
}

const COST_CATEGORIES = [
  { value: 'ELECTRICITY', label: 'Electricity' },
  { value: 'HOSTING', label: 'Hosting' },
  { value: 'MAINTENANCE', label: 'Maintenance' },
  { value: 'DEPRECIATION', label: 'Depreciation' },
  { value: 'NETWORK', label: 'Network' },
  { value: 'OTHER', label: 'Other' },
]

export default function CostsPage() {
  const { addToast } = useToast()
  const [costs, setCosts] = useState<Cost[]>([])
  const [summary, setSummary] = useState<CostSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [days, setDays] = useState(30)

  // Modal states
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)

  // Create form state
  const [createForm, setCreateForm] = useState({
    category: 'ELECTRICITY',
    amount: '',
    description: '',
    periodStart: new Date().toISOString().split('T')[0],
    periodEnd: new Date().toISOString().split('T')[0],
    nodeId: '',
  })

  const loadCosts = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    try {
      const [costsData, summaryData] = await Promise.all([
        api.costs.list({ limit: 50 }),
        api.costs.summary({ days }),
      ])
      setCosts(costsData.costs)
      setSummary(summaryData)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load costs')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [days])

  useEffect(() => {
    loadCosts()
  }, [loadCosts])

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
    }).format(value)
  }

  const getCategoryColor = (category: string): 'accent' | 'blue' | 'orange' | 'purple' | 'gray' => {
    switch (category) {
      case 'ELECTRICITY': return 'orange'
      case 'HOSTING': return 'blue'
      case 'MAINTENANCE': return 'accent'
      case 'DEPRECIATION': return 'purple'
      case 'NETWORK': return 'blue'
      default: return 'gray'
    }
  }

  const getCategoryBadgeStyle = (category: string) => {
    switch (category) {
      case 'ELECTRICITY': return 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20'
      case 'HOSTING': return 'bg-blue-500/10 text-blue-400 border-blue-500/20'
      case 'MAINTENANCE': return 'bg-orange-500/10 text-orange-400 border-orange-500/20'
      case 'DEPRECIATION': return 'bg-purple-500/10 text-purple-400 border-purple-500/20'
      case 'NETWORK': return 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20'
      default: return 'bg-text-muted/10 text-text-muted border-border'
    }
  }

  const getCategoryIcon = (category: string) => {
    switch (category) {
      case 'ELECTRICITY': return <Zap className="w-4 h-4" />
      case 'HOSTING': return <ServerIcon className="w-4 h-4" />
      case 'MAINTENANCE': return <Wrench className="w-4 h-4" />
      case 'DEPRECIATION': return <TrendingDown className="w-4 h-4" />
      case 'NETWORK': return <Globe className="w-4 h-4" />
      default: return <MoreHorizontal className="w-4 h-4" />
    }
  }

  async function handleCreateCost() {
    if (!createForm.amount || parseFloat(createForm.amount) <= 0) {
      addToast({ type: 'warning', title: 'Validation Error', message: 'Please enter a valid amount' })
      return
    }

    setProcessing(true)
    try {
      await api.costs.create({
        category: createForm.category,
        amount: parseFloat(createForm.amount),
        description: createForm.description || undefined,
        periodStart: createForm.periodStart,
        periodEnd: createForm.periodEnd,
        nodeId: createForm.nodeId || undefined,
      })
      setShowCreateModal(false)
      setCreateForm({
        category: 'ELECTRICITY',
        amount: '',
        description: '',
        periodStart: new Date().toISOString().split('T')[0],
        periodEnd: new Date().toISOString().split('T')[0],
        nodeId: '',
      })
      addToast({ type: 'success', title: 'Cost Created', message: 'Cost entry created successfully' })
      loadCosts()
    } catch (err) {
      addToast({ type: 'error', title: 'Error', message: err instanceof Error ? err.message : 'Failed to create cost entry' })
    } finally {
      setProcessing(false)
    }
  }

  async function handleDeleteCost() {
    if (!deletingId) return

    setProcessing(true)
    try {
      await api.costs.delete(deletingId)
      setShowDeleteModal(false)
      setDeletingId(null)
      addToast({ type: 'success', title: 'Cost Deleted', message: 'Cost entry deleted successfully' })
      loadCosts()
    } catch (err) {
      addToast({ type: 'error', title: 'Error', message: err instanceof Error ? err.message : 'Failed to delete cost entry' })
    } finally {
      setProcessing(false)
    }
  }

  // Build distribution segments
  const distributionSegments = summary?.byCategory
    ? Object.entries(summary.byCategory).map(([category, amount]) => ({
        label: category,
        value: amount,
        color: getCategoryColor(category),
      }))
    : []

  // Find top category
  const topCategory = summary?.byCategory
    ? Object.entries(summary.byCategory).sort((a, b) => b[1] - a[1])[0]
    : null

  return (
    <DashboardShell
      title="Cost Management"
      subtitle="Operational expense tracking"
      liveLabel="LIVE"
      onRefresh={() => loadCosts(true)}
      refreshing={refreshing}
    >
      <DashboardMainColumn>
        <div className="flex items-center justify-end gap-3">
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="px-4 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent"
            style={{ color: 'var(--text-primary)' }}
          >
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <Button onClick={() => setShowCreateModal(true)} variant="primary" size="sm" icon={<Plus className="w-4 h-4" />}>
            Add Cost
          </Button>
        </div>

        <MetricTriad
          metrics={[
            {
              label: 'Total Costs',
              value: formatCurrency(summary?.total ?? 0),
              icon: DollarSign,
              tone: 'orange',
            },
            {
              label: 'Entries',
              value: String(costs.length),
              detail: `${summary?.byCategory ? Object.keys(summary.byCategory).length : 0} categories`,
              icon: Receipt,
              tone: 'blue',
            },
            {
              label: 'Top Category',
              value: topCategory ? formatCurrency(topCategory[1]) : '$0.00',
              detail: topCategory?.[0] ?? '-',
              icon: TrendingUp,
              tone: 'purple',
            },
          ]}
        />

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

        {!loading && summary && summary.total > 0 && (
          <SectionCard title="Cost Distribution" icon={FolderOpen} badge={<span className="text-lg font-bold text-error ml-2">{formatCurrency(summary.total)}</span>}>
            <DistributionBar segments={distributionSegments} size="lg" showLegend />
          </SectionCard>
        )}

        <SectionCard title="Categories" icon={FolderOpen}>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            {COST_CATEGORIES.map(({ value, label }) => {
              const amount = summary?.byCategory?.[value] ?? 0
              const percentage = summary && summary.total > 0
                ? (amount / summary.total) * 100
                : 0
              return (
                <div key={value} className="text-center p-4 rounded-md border border-border" style={{ background: 'var(--bg-elevated)' }}>
                  <div className={`inline-flex items-center justify-center w-10 h-10 rounded-xl mb-3 ${getCategoryBadgeStyle(value).split(' ')[0]}`}>
                    {getCategoryIcon(value)}
                  </div>
                  <p className={`text-xs font-medium mb-2 ${getCategoryBadgeStyle(value).split(' ')[1]}`}>
                    {label}
                  </p>
                  <p className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
                    {formatCurrency(amount)}
                  </p>
                  <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                    {percentage.toFixed(1)}%
                  </p>
                </div>
              )
            })}
          </div>
        </SectionCard>

        <SectionCard title="Cost Entries" icon={List}>
          {costs.length === 0 ? (
            <div className="py-12 text-center">
              <Receipt className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--text-muted)' }} />
              <h3 className="font-display text-lg mb-1" style={{ color: 'var(--text-primary)' }}>No cost entries</h3>
              <p className="text-sm mb-5" style={{ color: 'var(--text-muted)' }}>
                Start tracking your operational expenses by adding a cost entry.
              </p>
              <Button onClick={() => setShowCreateModal(true)} variant="primary" size="sm">
                Add Your First Cost
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-3 px-4 text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Category</th>
                    <th className="text-left py-3 px-4 text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Description</th>
                    <th className="text-left py-3 px-4 text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Period</th>
                    <th className="text-right py-3 px-4 text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Amount</th>
                    <th className="text-right py-3 px-4 text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {costs.map((cost) => (
                    <tr key={cost.id} className="border-b border-border/50 hover:bg-surface-hover/50 transition-colors">
                      <td className="py-4 px-4">
                        <span className={`inline-flex items-center gap-2 px-3 py-1 rounded-lg text-xs font-medium border ${getCategoryBadgeStyle(cost.category)}`}>
                          {getCategoryIcon(cost.category)}
                          {cost.category}
                        </span>
                      </td>
                      <td className="py-4 px-4">
                        <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                          {cost.description || '-'}
                        </span>
                        {cost.nodeId && (
                          <span className="ml-2 text-xs bg-surface-hover px-2 py-0.5 rounded" style={{ color: 'var(--text-muted)' }}>
                            Node: {cost.nodeId.substring(0, 8)}...
                          </span>
                        )}
                      </td>
                      <td className="py-4 px-4 text-sm" style={{ color: 'var(--text-muted)' }}>
                        {new Date(cost.periodStart).toLocaleDateString()} - {new Date(cost.periodEnd).toLocaleDateString()}
                      </td>
                      <td className="py-4 px-4 text-right">
                        <span className="text-sm text-error font-semibold">
                          {formatCurrency(cost.amount)}
                        </span>
                      </td>
                      <td className="py-4 px-4 text-right">
                        <button
                          onClick={() => {
                            setDeletingId(cost.id)
                            setShowDeleteModal(true)
                          }}
                          className="px-3 py-1.5 text-xs bg-error/10 text-error rounded-lg hover:bg-error/20 transition-colors"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      </DashboardMainColumn>

      <DashboardRightRail>
        <SectionCard title="Snapshot" icon={Check}>
          <div className="space-y-3">
            <div className="flex justify-between items-baseline">
              <span className="font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-muted)' }}>Entries</span>
              <span className="font-display text-sm" style={{ color: 'var(--text-primary)' }}>{costs.length}</span>
            </div>
            <div className="flex justify-between items-baseline">
              <span className="font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-muted)' }}>Categories</span>
              <span className="font-display text-sm" style={{ color: 'var(--text-primary)' }}>{summary?.byCategory ? Object.keys(summary.byCategory).length : 0}</span>
            </div>
            <div className="flex justify-between items-baseline">
              <span className="font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-muted)' }}>Period</span>
              <span className="font-display text-sm" style={{ color: 'var(--text-primary)' }}>{days}d</span>
            </div>
          </div>
        </SectionCard>
      </DashboardRightRail>

      {/* Create Cost Modal */}
      <Modal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        title="Add Cost Entry"
        size="md"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
              Category
            </label>
            <Select
              value={createForm.category}
              onChange={(e) => setCreateForm({ ...createForm, category: e.target.value })}
              options={COST_CATEGORIES}
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
              Amount (USD)
            </label>
            <Input
              type="number"
              value={createForm.amount}
              onChange={(e) => setCreateForm({ ...createForm, amount: e.target.value })}
              placeholder="0.00"
              min="0"
              step="0.01"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
              Description (optional)
            </label>
            <Input
              type="text"
              value={createForm.description}
              onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })}
              placeholder="e.g., Monthly hosting fee"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                Period Start
              </label>
              <Input
                type="date"
                value={createForm.periodStart}
                onChange={(e) => setCreateForm({ ...createForm, periodStart: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                Period End
              </label>
              <Input
                type="date"
                value={createForm.periodEnd}
                onChange={(e) => setCreateForm({ ...createForm, periodEnd: e.target.value })}
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
              Node ID (optional)
            </label>
            <Input
              type="text"
              value={createForm.nodeId}
              onChange={(e) => setCreateForm({ ...createForm, nodeId: e.target.value })}
              placeholder="Associate with a specific node"
            />
          </div>

          <div className="flex gap-3 pt-4">
            <Button onClick={() => setShowCreateModal(false)} variant="outline" className="flex-1" disabled={processing}>
              Cancel
            </Button>
            <Button onClick={handleCreateCost} variant="primary" className="flex-1" loading={processing}>
              Add Cost
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmModal
        isOpen={showDeleteModal}
        onClose={() => {
          setShowDeleteModal(false)
          setDeletingId(null)
        }}
        onConfirm={handleDeleteCost}
        title="Delete Cost Entry"
        message="Are you sure you want to delete this cost entry? This action cannot be undone."
        confirmText={processing ? 'Deleting...' : 'Delete'}
        variant="danger"
        loading={processing}
      />
    </DashboardShell>
  )
}
