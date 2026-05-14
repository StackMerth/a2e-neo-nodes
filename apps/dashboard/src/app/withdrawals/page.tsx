'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Wallet,
  Clock,
  CheckCircle,
  Loader2,
  ExternalLink,
  ArrowRightCircle,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Modal } from '@/components/ui/Modal'
import {
  DashboardShell,
  MetricTriad,
  DataTableCard,
  type DataTableColumn,
  type MetricCardData,
} from '@/components/dashboard/FuturisticShell'

interface Withdrawal {
  id: string
  nodeRunnerId: string
  nodeRunnerName: string
  amount: number
  walletAddress: string
  status: string
  txHash: string | null
  reason: string | null
  createdAt: string
  updatedAt: string
}

type WithdrawalRow = Withdrawal & Record<string, unknown>

interface Counts {
  pending: number
  approved: number
  processing: number
  completed: number
  rejected: number
}

type StatusFilter = 'all' | 'PENDING' | 'APPROVED' | 'PROCESSING' | 'COMPLETED' | 'REJECTED'

const STATUS_FILTERS: { label: string; value: StatusFilter }[] = [
  { label: 'All', value: 'all' },
  { label: 'Pending', value: 'PENDING' },
  { label: 'Approved', value: 'APPROVED' },
  { label: 'Processing', value: 'PROCESSING' },
  { label: 'Completed', value: 'COMPLETED' },
  { label: 'Rejected', value: 'REJECTED' },
]

function truncateAddress(addr: string): string {
  if (!addr || addr.length <= 12) return addr
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

export default function WithdrawalsPage() {
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([])
  const [counts, setCounts] = useState<Counts>({ pending: 0, approved: 0, processing: 0, completed: 0, rejected: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [toast, setToast] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  // Modal states
  const [completeModalOpen, setCompleteModalOpen] = useState(false)
  const [rejectModalOpen, setRejectModalOpen] = useState(false)
  const [selectedWithdrawal, setSelectedWithdrawal] = useState<Withdrawal | null>(null)

  // Complete form
  const [txHash, setTxHash] = useState('')
  // Reject form
  const [rejectReason, setRejectReason] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const loadData = useCallback(async () => {
    try {
      setLoading(true)
      const status = filter !== 'all' ? filter : undefined
      const data = await api.withdrawals.list(status)
      setWithdrawals(data.withdrawals || [])
      setCounts(data.counts || { pending: 0, approved: 0, processing: 0, completed: 0, rejected: 0 })
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load withdrawal requests')
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => {
    loadData()
  }, [loadData])

  // Auto-refresh every 10 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      loadData()
    }, 10000)
    return () => clearInterval(interval)
  }, [loadData])

  // Auto-hide toast after 4 seconds
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 4000)
      return () => clearTimeout(timer)
    }
  }, [toast])

  async function handleApprove(id: string) {
    try {
      setActionLoading(id)
      await api.withdrawals.approve(id)
      setToast('Withdrawal approved')
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve withdrawal')
    } finally {
      setActionLoading(null)
    }
  }

  async function handleProcess(id: string) {
    try {
      setActionLoading(id)
      await api.withdrawals.process(id)
      setToast('Withdrawal marked as processing')
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to process withdrawal')
    } finally {
      setActionLoading(null)
    }
  }

  function openCompleteModal(w: Withdrawal) {
    setSelectedWithdrawal(w)
    setTxHash('')
    setCompleteModalOpen(true)
  }

  async function handleCompleteSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedWithdrawal || !txHash.trim()) return
    try {
      setSubmitting(true)
      await api.withdrawals.complete(selectedWithdrawal.id, txHash.trim())
      setCompleteModalOpen(false)
      setToast('Withdrawal completed')
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to complete withdrawal')
    } finally {
      setSubmitting(false)
    }
  }

  function openRejectModal(w: Withdrawal) {
    setSelectedWithdrawal(w)
    setRejectReason('')
    setRejectModalOpen(true)
  }

  async function handleRejectSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedWithdrawal) return
    try {
      setSubmitting(true)
      await api.withdrawals.reject(selectedWithdrawal.id, rejectReason || undefined)
      setRejectModalOpen(false)
      setToast('Withdrawal rejected')
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reject withdrawal')
    } finally {
      setSubmitting(false)
    }
  }

  function getStatusBadge(status: string) {
    switch (status) {
      case 'PENDING':
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-warning/10 text-warning">
            Pending
          </span>
        )
      case 'APPROVED':
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-blue-500/10 text-blue-400">
            Approved
          </span>
        )
      case 'PROCESSING':
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-accent-purple/10 text-accent-purple flex items-center gap-1.5">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent-purple opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-accent-purple" />
            </span>
            Processing
          </span>
        )
      case 'COMPLETED':
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-accent/10 text-accent">
            Completed
          </span>
        )
      case 'REJECTED':
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-error/10 text-error">
            Rejected
          </span>
        )
      default:
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-text-muted/10 text-text-muted">
            {status}
          </span>
        )
    }
  }

  function getFilterCount(value: StatusFilter): number {
    if (value === 'all') return withdrawals.length
    switch (value) {
      case 'PENDING': return counts.pending
      case 'APPROVED': return counts.approved
      case 'PROCESSING': return counts.processing
      case 'COMPLETED': return counts.completed
      case 'REJECTED': return counts.rejected
      default: return 0
    }
  }

  const metrics: MetricCardData[] = [
    { label: 'Pending', value: counts.pending, icon: Clock, tone: 'orange' },
    { label: 'Processing', value: counts.processing, icon: ArrowRightCircle, tone: 'purple' },
    { label: 'Completed', value: counts.completed, icon: CheckCircle, tone: 'green' },
  ]

  const columns: Array<DataTableColumn<WithdrawalRow>> = [
    {
      key: 'nodeRunnerName',
      header: 'Node Runner',
      render: (w) => (
        <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          {w.nodeRunnerName}
        </span>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      mono: true,
      render: (w) => `$${w.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    },
    {
      key: 'walletAddress',
      header: 'Wallet',
      mono: true,
      render: (w) => (
        <span className="text-xs cursor-pointer hover:text-accent" title={w.walletAddress} style={{ color: 'var(--text-secondary)' }}>
          {truncateAddress(w.walletAddress)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (w) => getStatusBadge(w.status),
    },
    {
      key: 'createdAt',
      header: 'Date',
      mono: true,
      render: (w) => new Date(w.createdAt).toLocaleDateString(),
    },
    {
      key: 'id',
      header: 'Actions',
      align: 'right',
      render: (w) => (
        <div className="flex items-center justify-end gap-2">
          {w.status === 'PENDING' && (
            <>
              <button
                onClick={() => handleApprove(w.id)}
                disabled={actionLoading === w.id}
                className="px-3 py-1.5 text-xs bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 rounded-md transition-colors disabled:opacity-50"
              >
                {actionLoading === w.id ? <Loader2 size={12} className="animate-spin" /> : 'Approve'}
              </button>
              <button
                onClick={() => openRejectModal(w)}
                className="px-3 py-1.5 text-xs text-error/70 hover:text-error transition-colors"
              >
                Reject
              </button>
            </>
          )}
          {w.status === 'APPROVED' && (
            <button
              onClick={() => handleProcess(w.id)}
              disabled={actionLoading === w.id}
              className="px-3 py-1.5 text-xs bg-accent-purple/10 text-accent-purple hover:bg-accent-purple/20 rounded-md transition-colors disabled:opacity-50"
            >
              {actionLoading === w.id ? <Loader2 size={12} className="animate-spin" /> : 'Process'}
            </button>
          )}
          {w.status === 'PROCESSING' && (
            <button
              onClick={() => openCompleteModal(w)}
              className="px-3 py-1.5 text-xs bg-accent/10 text-accent hover:bg-accent/20 rounded-md transition-colors"
            >
              Complete
            </button>
          )}
          {w.status === 'COMPLETED' && w.txHash && (
            <a
              href={`https://solscan.io/tx/${w.txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 text-xs bg-accent/10 text-accent hover:bg-accent/20 rounded-md transition-colors inline-flex items-center gap-1.5"
            >
              View TX
              <ExternalLink size={10} />
            </a>
          )}
        </div>
      ),
    },
  ]

  const statusPills = (
    <div className="flex items-center gap-2 flex-wrap">
      {STATUS_FILTERS.map((sf) => {
        const isActive = filter === sf.value
        return (
          <button
            key={sf.value}
            onClick={() => setFilter(sf.value)}
            className="px-3 py-1.5 text-xs font-medium rounded-md transition-colors"
            style={isActive
              ? { background: 'var(--primary)', color: '#fff' }
              : { background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }
            }
          >
            {sf.label}
            <span className="ml-1.5" style={{ color: isActive ? 'rgba(255,255,255,0.7)' : 'var(--text-muted)' }}>
              {getFilterCount(sf.value)}
            </span>
          </button>
        )
      })}
    </div>
  )

  return (
    <DashboardShell
      title="Withdrawal Requests"
      subtitle={counts.pending > 0 ? `${counts.pending} pending review` : `${withdrawals.length} withdrawals`}
      onRefresh={loadData}
      refreshing={loading}
    >
      <div className="lg:col-span-3 space-y-6">
        {/* Toast */}
        {toast && (
          <div className="fixed top-4 right-4 z-50 bg-accent text-white px-4 py-3 rounded-lg shadow-lg animate-scaleIn">
            {toast}
          </div>
        )}

        {error && (
          <div className="bg-error/10 border border-error/20 text-error px-4 py-3 rounded-lg">
            {error}
            <button
              onClick={() => setError(null)}
              className="ml-3 text-error/70 hover:text-error underline text-sm"
            >
              Dismiss
            </button>
          </div>
        )}

        <MetricTriad metrics={metrics} />

        <DataTableCard<WithdrawalRow>
          title={filter === 'all' ? 'All Withdrawals' : `${STATUS_FILTERS.find(f => f.value === filter)?.label} Withdrawals`}
          icon={Wallet}
          actions={statusPills}
          columns={columns}
          rows={withdrawals as WithdrawalRow[]}
          loading={loading && withdrawals.length === 0}
          empty={
            <p className="text-center text-sm" style={{ color: 'var(--text-muted)' }}>
              No withdrawal requests found
            </p>
          }
        />
      </div>

      {/* Complete Modal - Enter TX Hash */}
      <Modal
        isOpen={completeModalOpen}
        onClose={() => setCompleteModalOpen(false)}
        title="Complete Withdrawal"
        size="md"
      >
        <form onSubmit={handleCompleteSubmit} className="space-y-4">
          <p className="text-text-muted">
            Enter the on-chain transaction hash to confirm the withdrawal to{' '}
            <span className="text-text-primary font-medium">{selectedWithdrawal?.nodeRunnerName}</span>
            {' '}for{' '}
            <span className="text-accent font-medium">
              ${selectedWithdrawal?.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </p>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Transaction Hash *
            </label>
            <input
              type="text"
              value={txHash}
              onChange={(e) => setTxHash(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              placeholder="5UfDuX..."
              required
            />
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={() => setCompleteModalOpen(false)}
              className="px-4 py-2 text-text-secondary hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !txHash.trim()}
              className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {submitting ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Completing...
                </>
              ) : (
                'Confirm Completion'
              )}
            </button>
          </div>
        </form>
      </Modal>

      {/* Reject Modal */}
      <Modal
        isOpen={rejectModalOpen}
        onClose={() => setRejectModalOpen(false)}
        title="Reject Withdrawal"
        size="md"
      >
        <form onSubmit={handleRejectSubmit} className="space-y-4">
          <p className="text-text-muted">
            Reject withdrawal request from{' '}
            <span className="text-text-primary font-medium">{selectedWithdrawal?.nodeRunnerName}</span>?
          </p>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Reason (optional)
            </label>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-error"
              placeholder="Reason for rejection..."
              rows={3}
            />
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={() => setRejectModalOpen(false)}
              className="px-4 py-2 text-text-secondary hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 bg-error hover:bg-error/80 text-white rounded-lg font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {submitting ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Rejecting...
                </>
              ) : (
                'Reject Withdrawal'
              )}
            </button>
          </div>
        </form>
      </Modal>
    </DashboardShell>
  )
}
