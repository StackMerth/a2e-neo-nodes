'use client'

import { useEffect, useState, useCallback } from 'react'
import { motion } from 'framer-motion'
import { Receipt, Plus, Trash2, DollarSign, FolderOpen, TrendingUp, List, RefreshCw, AlertTriangle, X, Check, Zap, Server as ServerIcon, Wrench, TrendingDown, Globe, MoreHorizontal } from 'lucide-react'
import { Card, StatCard } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input, Select } from '@/components/ui/Input'
import { Modal, ConfirmModal } from '@/components/ui/Modal'
import { DistributionBar } from '@/components/ui/ProgressBar'
import { EmptyState } from '@/components/ui/EmptyState'
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
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
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

  const loadCosts = useCallback(async () => {
    setLoading(true)
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
    <motion.div variants={container} initial="hidden" animate="show" className="space-y-8">
      {/* Hero Section */}
      <motion.div variants={item} className="relative py-8 md:py-12">
        {/* Background gradient */}
        <div className="absolute inset-0 bg-gradient-to-b from-error/5 via-transparent to-transparent rounded-3xl" />

        <div className="relative text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-error/5 border border-error/20 rounded-full mb-6 animate-slideUp">
            <Receipt className="w-4 h-4 text-error" />
            <span className="text-xs text-error font-medium uppercase tracking-wider">Expense Tracking</span>
          </div>

          <h1 className="text-3xl md:text-5xl font-bold text-text-primary mb-3">
            Cost Management
          </h1>
          <p className="text-text-muted max-w-xl mx-auto">
            Track operational expenses, analyze cost breakdown by category,
            and manage your GPU infrastructure costs.
          </p>
        </div>
      </motion.div>

      {/* Actions Bar */}
      <motion.div variants={item} className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-text-primary focus:outline-none focus:border-accent"
          >
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <Button onClick={loadCosts} variant="outline" size="sm" icon={<RefreshCw className="w-4 h-4" />}>
            Refresh
          </Button>
        </div>
        <Button onClick={() => setShowCreateModal(true)} variant="primary" icon={<Plus className="w-4 h-4" />}>
          Add Cost
        </Button>
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
            <div className="w-10 h-10 border-2 border-error border-t-transparent rounded-full animate-spin" />
            <p className="text-text-muted">Loading costs data...</p>
          </div>
        </div>
      ) : (
        <>
          {/* Stats Grid */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              label="Total Costs"
              value={formatCurrency(summary?.total ?? 0)}
              variant="orange"
              animate
              icon={<DollarSign className="w-4 h-4" />}
            />
            <StatCard
              label="Cost Entries"
              value={costs.length}
              variant="blue"
              animate
              icon={<Receipt className="w-4 h-4" />}
            />
            <StatCard
              label="Categories"
              value={summary?.byCategory ? Object.keys(summary.byCategory).length : 0}
              variant="purple"
              animate
              icon={<FolderOpen className="w-4 h-4" />}
            />
            <StatCard
              label="Top Category"
              value={topCategory ? topCategory[0] : 'N/A'}
              animate
              icon={<TrendingUp className="w-4 h-4" />}
            />
          </div>

          {/* Cost Distribution */}
          {summary && summary.total > 0 && (
            <Card variant="glass" hover={false}>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-sm font-medium text-text-primary">Cost Distribution</h3>
                  <p className="text-xs text-text-muted">Breakdown by category for the last {days} days</p>
                </div>
                <span className="text-lg font-bold text-error">{formatCurrency(summary.total)}</span>
              </div>
              <DistributionBar segments={distributionSegments} size="lg" showLegend />
            </Card>
          )}

          {/* Category Cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            {COST_CATEGORIES.map(({ value, label }) => {
              const amount = summary?.byCategory?.[value] ?? 0
              const percentage = summary && summary.total > 0
                ? (amount / summary.total) * 100
                : 0
              return (
                <Card
                  key={value}
                  variant="glass"
                  className="text-center"
                  hover={amount > 0}
                >
                  <div className={`inline-flex items-center justify-center w-10 h-10 rounded-xl mb-3 ${getCategoryBadgeStyle(value).split(' ')[0]}`}>
                    {getCategoryIcon(value)}
                  </div>
                  <p className={`text-xs font-medium mb-2 ${getCategoryBadgeStyle(value).split(' ')[1]}`}>
                    {label}
                  </p>
                  <p className="text-xl font-bold text-text-primary">
                    {formatCurrency(amount)}
                  </p>
                  <p className="text-xs text-text-muted mt-1">
                    {percentage.toFixed(1)}%
                  </p>
                </Card>
              )
            })}
          </div>

          {/* Cost Entries Table */}
          <Card variant="glass" hover={false}>
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-error to-orange-400 flex items-center justify-center">
                <List className="w-5 h-5 text-white" />
              </div>
              <div>
                <h3 className="font-semibold text-text-primary">Cost Entries</h3>
                <p className="text-xs text-text-muted">Individual cost records</p>
              </div>
            </div>

            {costs.length === 0 ? (
              <EmptyState
                icon={<Receipt className="w-8 h-8" />}
                title="No cost entries"
                description="Start tracking your operational expenses by adding a cost entry."
                action={
                  <Button onClick={() => setShowCreateModal(true)} variant="primary" size="sm">
                    Add Your First Cost
                  </Button>
                }
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-3 px-4 text-xs text-text-muted uppercase tracking-wider">Category</th>
                      <th className="text-left py-3 px-4 text-xs text-text-muted uppercase tracking-wider">Description</th>
                      <th className="text-left py-3 px-4 text-xs text-text-muted uppercase tracking-wider">Period</th>
                      <th className="text-right py-3 px-4 text-xs text-text-muted uppercase tracking-wider">Amount</th>
                      <th className="text-right py-3 px-4 text-xs text-text-muted uppercase tracking-wider">Actions</th>
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
                          <span className="text-sm text-text-secondary">
                            {cost.description || '-'}
                          </span>
                          {cost.nodeId && (
                            <span className="ml-2 text-xs text-text-muted bg-surface-hover px-2 py-0.5 rounded">
                              Node: {cost.nodeId.substring(0, 8)}...
                            </span>
                          )}
                        </td>
                        <td className="py-4 px-4 text-sm text-text-muted">
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
          </Card>
        </>
      )}

      {/* Create Cost Modal */}
      <Modal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        title="Add Cost Entry"
        size="md"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-2">
              Category
            </label>
            <Select
              value={createForm.category}
              onChange={(e) => setCreateForm({ ...createForm, category: e.target.value })}
              options={COST_CATEGORIES}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-2">
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
            <label className="block text-sm font-medium text-text-primary mb-2">
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
              <label className="block text-sm font-medium text-text-primary mb-2">
                Period Start
              </label>
              <Input
                type="date"
                value={createForm.periodStart}
                onChange={(e) => setCreateForm({ ...createForm, periodStart: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-2">
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
            <label className="block text-sm font-medium text-text-primary mb-2">
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
            <Button
              onClick={() => setShowCreateModal(false)}
              variant="outline"
              className="flex-1"
              disabled={processing}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreateCost}
              variant="primary"
              className="flex-1"
              loading={processing}
            >
              Add Cost
            </Button>
          </div>
        </div>
      </Modal>

      {/* Delete Confirmation Modal */}
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
    </motion.div>
  )
}

// =============================================================================
// ICONS
// =============================================================================

function ReceiptIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" />
    </svg>
  )
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
    </svg>
  )
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
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

function DollarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function FolderIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
    </svg>
  )
}

function TrendingUpIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
    </svg>
  )
}

function ListIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
    </svg>
  )
}

function BoltIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
    </svg>
  )
}

// ServerIcon removed - using lucide-react import

function WrenchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  )
}

function ChartDownIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 17h8m0 0V9m0 8l-8-8-4 4-6-6" />
    </svg>
  )
}

function GlobeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function DotsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h.01M12 12h.01M19 12h.01M6 12a1 1 0 11-2 0 1 1 0 012 0zm7 0a1 1 0 11-2 0 1 1 0 012 0zm7 0a1 1 0 11-2 0 1 1 0 012 0z" />
    </svg>
  )
}
