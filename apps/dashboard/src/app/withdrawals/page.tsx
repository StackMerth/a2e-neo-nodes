'use client'

import { useState, useEffect, useCallback } from 'react'
import { motion } from 'framer-motion'
import {
  Wallet,
  Clock,
  CheckCircle,
  Loader2,
  RefreshCw,
  XCircle,
  ExternalLink,
  ArrowRightCircle,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Modal } from '@/components/ui/Modal'

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const itemVar = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

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
  // T3.2: payout rail. SOLANA goes through the existing /complete
  // flow (admin pastes Solana txHash after manual transfer).
  // STRIPE_CONNECT goes through /process-stripe (one-click: backend
  // calls Stripe Transfers API, captures tr_xxx, marks COMPLETED).
  payoutMethod?: 'SOLANA' | 'STRIPE_CONNECT'
  stripeTransferId?: string | null
}

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

  // T3.2.1a: end-to-end Stripe Transfer for STRIPE_CONNECT withdrawals.
  // Single click here = stripe.transfers.create() runs server-side,
  // operator's connected account gets credited, Stripe pays out to
  // their bank on its normal cadence (usually next business day).
  async function handleProcessStripe(id: string) {
    if (!confirm('Push this withdrawal to the operator\'s bank via Stripe? Stripe transfers are irreversible.')) return
    try {
      setActionLoading(id)
      const result = await api.withdrawals.processStripe(id)
      setToast(`Stripe transfer ${result.stripeTransferId.slice(0, 10)}… sent. Operator will receive USD on next bank business day.`)
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Stripe transfer failed')
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

  if (loading && withdrawals.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" />
      </div>
    )
  }

  return (
    <motion.div className="space-y-6" variants={container} initial="hidden" animate="show">
      {/* Toast */}
      {toast && (
        <div className="fixed top-4 right-4 z-50 bg-accent text-white px-4 py-3 rounded-lg shadow-lg animate-scaleIn">
          {toast}
        </div>
      )}

      {/* Header */}
      <motion.div variants={itemVar} className="dash-header">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
          <Wallet size={28} style={{ color: 'var(--primary)' }} />
          Withdrawal Requests
          {counts.pending > 0 && (
            <span className="px-2.5 py-1 text-sm font-semibold bg-warning/10 text-warning rounded-lg">
              {counts.pending} pending
            </span>
          )}
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            onClick={() => loadData()}
            className="px-3 py-2 text-sm bg-surface border border-border rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors flex items-center gap-2"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </motion.div>

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

      {/* KPI Stat Blocks */}
      <motion.div variants={itemVar} className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div
          className={`bg-surface border rounded-xl p-4 cursor-pointer transition-colors ${
            filter === 'PENDING' ? 'border-warning' : 'border-border hover:border-warning/50'
          }`}
          onClick={() => setFilter(filter === 'PENDING' ? 'all' : 'PENDING')}
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-warning/10 rounded-lg flex items-center justify-center">
              <Clock size={20} className="text-warning" />
            </div>
            <div>
              <p className="text-text-muted text-sm">Pending</p>
              <p className="text-2xl font-bold text-warning">{counts.pending}</p>
            </div>
          </div>
        </div>

        <div
          className={`bg-surface border rounded-xl p-4 cursor-pointer transition-colors ${
            filter === 'APPROVED' ? 'border-blue-400' : 'border-border hover:border-blue-400/50'
          }`}
          onClick={() => setFilter(filter === 'APPROVED' ? 'all' : 'APPROVED')}
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-500/10 rounded-lg flex items-center justify-center">
              <CheckCircle size={20} className="text-blue-400" />
            </div>
            <div>
              <p className="text-text-muted text-sm">Approved</p>
              <p className="text-2xl font-bold text-blue-400">{counts.approved}</p>
            </div>
          </div>
        </div>

        <div
          className={`bg-surface border rounded-xl p-4 cursor-pointer transition-colors ${
            filter === 'PROCESSING' ? 'border-accent-purple' : 'border-border hover:border-accent-purple/50'
          }`}
          onClick={() => setFilter(filter === 'PROCESSING' ? 'all' : 'PROCESSING')}
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-accent-purple/10 rounded-lg flex items-center justify-center">
              <ArrowRightCircle size={20} className="text-accent-purple" />
            </div>
            <div>
              <p className="text-text-muted text-sm">Processing</p>
              <p className="text-2xl font-bold text-accent-purple">{counts.processing}</p>
            </div>
          </div>
        </div>

        <div
          className={`bg-surface border rounded-xl p-4 cursor-pointer transition-colors ${
            filter === 'COMPLETED' ? 'border-accent' : 'border-border hover:border-accent/50'
          }`}
          onClick={() => setFilter(filter === 'COMPLETED' ? 'all' : 'COMPLETED')}
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-accent/10 rounded-lg flex items-center justify-center">
              <CheckCircle size={20} className="text-accent" />
            </div>
            <div>
              <p className="text-text-muted text-sm">Completed</p>
              <p className="text-2xl font-bold text-accent">{counts.completed}</p>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Status Filter Pills */}
      <div className="flex items-center gap-2 flex-wrap">
        {STATUS_FILTERS.map((sf) => (
          <button
            key={sf.value}
            onClick={() => setFilter(sf.value)}
            className={`px-3 py-1.5 text-sm rounded-lg font-medium transition-colors ${
              filter === sf.value
                ? 'bg-accent text-white'
                : 'bg-surface border border-border text-text-secondary hover:text-text-primary hover:bg-surface-hover'
            }`}
          >
            {sf.label}
            <span className={`ml-1.5 ${filter === sf.value ? 'text-white/70' : 'text-text-muted'}`}>
              {getFilterCount(sf.value)}
            </span>
          </button>
        ))}
      </div>

      {/* Requests Table */}
      <div className="rounded-xl overflow-hidden" style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">
            {filter === 'all' ? 'All Withdrawals' : `${STATUS_FILTERS.find(f => f.value === filter)?.label} Withdrawals`}
          </h2>
          {filter !== 'all' && (
            <button
              onClick={() => setFilter('all')}
              className="text-sm text-accent hover:underline"
            >
              Show all
            </button>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-surface-hover">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">Node Runner</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">Amount</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">Wallet Address</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">Status</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">Date</th>
                <th className="px-6 py-3 text-right text-xs font-semibold text-text-muted uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {withdrawals.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-text-muted">
                    No withdrawal requests found
                  </td>
                </tr>
              ) : (
                withdrawals.map((w) => (
                  <tr key={w.id} className="hover:bg-surface-hover transition-colors">
                    <td className="px-6 py-4">
                      <p className="font-medium text-text-primary text-sm">{w.nodeRunnerName}</p>
                    </td>
                    <td className="px-6 py-4">
                      <span className="text-text-primary font-medium">
                        ${w.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      {w.payoutMethod === 'STRIPE_CONNECT' ? (
                        <span
                          className="inline-flex items-center gap-1.5 font-mono text-sm text-purple-300"
                          title="Routes to operator's connected Stripe account, then to their bank"
                        >
                          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-purple-500/15 border border-purple-500/30">
                            Bank
                          </span>
                          via Stripe
                        </span>
                      ) : (
                        <span
                          className="font-mono text-sm text-text-secondary cursor-pointer hover:text-accent transition-colors"
                          title={w.walletAddress}
                        >
                          {truncateAddress(w.walletAddress)}
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      {getStatusBadge(w.status)}
                    </td>
                    <td className="px-6 py-4 text-text-muted text-sm">
                      {new Date(w.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {w.status === 'PENDING' && (
                          <>
                            <button
                              onClick={() => handleApprove(w.id)}
                              disabled={actionLoading === w.id}
                              className="px-3 py-1.5 text-sm bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 rounded-lg transition-colors disabled:opacity-50"
                            >
                              {actionLoading === w.id ? <Loader2 size={14} className="animate-spin" /> : 'Approve'}
                            </button>
                            <button
                              onClick={() => openRejectModal(w)}
                              className="px-3 py-1.5 text-sm text-error/70 hover:text-error transition-colors"
                            >
                              Reject
                            </button>
                          </>
                        )}
                        {w.status === 'APPROVED' && (
                          <button
                            onClick={() => handleProcess(w.id)}
                            disabled={actionLoading === w.id}
                            className="px-3 py-1.5 text-sm bg-accent-purple/10 text-accent-purple hover:bg-accent-purple/20 rounded-lg transition-colors disabled:opacity-50"
                          >
                            {actionLoading === w.id ? <Loader2 size={14} className="animate-spin" /> : 'Process'}
                          </button>
                        )}
                        {/* T3.2.1a: STRIPE_CONNECT withdrawals get a
                            one-click Process via Stripe button on
                            APPROVED or PROCESSING. Replaces the manual
                            Solana txHash-paste flow with an end-to-end
                            stripe.transfers.create() call. */}
                        {w.payoutMethod === 'STRIPE_CONNECT' &&
                          (w.status === 'APPROVED' || w.status === 'PROCESSING') && (
                            <button
                              onClick={() => handleProcessStripe(w.id)}
                              disabled={actionLoading === w.id}
                              className="px-3 py-1.5 text-sm bg-purple-500/10 text-purple-300 hover:bg-purple-500/20 rounded-lg transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
                              title="One-click Stripe Transfer — funds land in operator's bank on next business day"
                            >
                              {actionLoading === w.id ? (
                                <Loader2 size={14} className="animate-spin" />
                              ) : (
                                <>Process via Stripe</>
                              )}
                            </button>
                          )}
                        {w.payoutMethod !== 'STRIPE_CONNECT' && w.status === 'PROCESSING' && (
                          <button
                            onClick={() => openCompleteModal(w)}
                            className="px-3 py-1.5 text-sm bg-accent/10 text-accent hover:bg-accent/20 rounded-lg transition-colors"
                          >
                            Complete
                          </button>
                        )}
                        {w.status === 'COMPLETED' && w.txHash && w.payoutMethod !== 'STRIPE_CONNECT' && (
                          <a
                            href={`https://solscan.io/tx/${w.txHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="px-3 py-1.5 text-sm bg-accent/10 text-accent hover:bg-accent/20 rounded-lg transition-colors inline-flex items-center gap-1.5"
                          >
                            View TX
                            <ExternalLink size={12} />
                          </a>
                        )}
                        {/* T3.2.1a: completed Stripe withdrawals show
                            the transfer id (linkable to the Stripe
                            dashboard). */}
                        {w.status === 'COMPLETED' && w.payoutMethod === 'STRIPE_CONNECT' && w.stripeTransferId && (
                          <a
                            href={`https://dashboard.stripe.com/transfers/${w.stripeTransferId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="px-3 py-1.5 text-sm bg-purple-500/10 text-purple-300 hover:bg-purple-500/20 rounded-lg transition-colors inline-flex items-center gap-1.5"
                            title={w.stripeTransferId}
                          >
                            Stripe Transfer
                            <ExternalLink size={12} />
                          </a>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
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
            {' '}&mdash;{' '}
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
    </motion.div>
  )
}
