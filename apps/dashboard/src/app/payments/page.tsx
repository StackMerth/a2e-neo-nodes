'use client'

import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { Card, StatCard } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { ConfirmModal } from '@/components/ui/Modal'
import { EmptyState } from '@/components/ui/EmptyState'
import { useToast } from '@/components/ui/Toast'
import { api } from '@/lib/api'

interface Payment {
  id: string
  settlementId: string
  amount: number
  currency: string
  recipientAddress: string
  txHash: string | null
  status: string
  isDevMode: boolean
  createdAt: string
  confirmedAt: string | null
}

interface PaymentStats {
  currentMode: string
  modeDescription: string
  stats: {
    total: number
    confirmed: number
    failed: number
    devModePayments: number
    totalAmountPaid: number
  }
}

interface PendingSettlement {
  nodeId: string
  walletAddress: string
  amount: number
  jobCount: number
}

interface Pagination {
  page: number
  limit: number
  total: number
  totalPages: number
}

export default function PaymentsPage() {
  const { addToast } = useToast()
  const [payments, setPayments] = useState<Payment[]>([])
  const [stats, setStats] = useState<PaymentStats | null>(null)
  const [pendingSettlements, setPendingSettlements] = useState<PendingSettlement[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pagination, setPagination] = useState<Pagination | null>(null)
  const [verifying, setVerifying] = useState<string | null>(null)
  const [selectedSettlements, setSelectedSettlements] = useState<string[]>([])
  const [batchProcessing, setBatchProcessing] = useState(false)
  const [showBatchModal, setShowBatchModal] = useState(false)
  const [useOnchainBatch, setUseOnchainBatch] = useState(true)
  const [walletBalance, setWalletBalance] = useState<{ sol: number; usdc: number; isDevMode: boolean } | null>(null)

  useEffect(() => {
    loadData()
  }, [filter, page])

  async function loadData() {
    setLoading(true)
    try {
      const [paymentsRes, statsRes, pendingRes, balanceRes] = await Promise.all([
        api.payments.list({
          status: filter !== 'all' ? filter : undefined,
          limit: 20,
          page
        }),
        api.payments.stats(),
        api.settlements.pending(),
        api.payments.balance(),
      ])
      setPayments(paymentsRes.payments)
      setPagination(paymentsRes.pagination)
      setStats(statsRes)
      setPendingSettlements(pendingRes.pending)
      setWalletBalance(balanceRes.balances ? { ...balanceRes.balances, isDevMode: balanceRes.isDevMode } : null)
    } catch (err) {
      console.error('Failed to load payments:', err)
    } finally {
      setLoading(false)
    }
  }

  const filteredPayments = useMemo(() => {
    if (!search.trim()) return payments
    const term = search.toLowerCase()
    return payments.filter(
      p =>
        p.recipientAddress.toLowerCase().includes(term) ||
        p.txHash?.toLowerCase().includes(term) ||
        p.id.toLowerCase().includes(term) ||
        p.settlementId.toLowerCase().includes(term)
    )
  }, [payments, search])

  function handleExportCSV() {
    api.reports.downloadCSV('settlements')
  }

  async function handleBatchProcess() {
    if (selectedSettlements.length === 0) return
    setBatchProcessing(true)
    try {
      if (useOnchainBatch && selectedSettlements.length <= 15) {
        const result = await api.payments.batchOnchain(selectedSettlements, 'USDC')
        if (result.success) {
          addToast({ type: 'success', title: 'On-chain Batch Complete', message: `Tx: ${result.txHash?.substring(0, 20)}... | ${result.processed} recipients | $${result.totalAmount.toFixed(2)}` })
        } else {
          addToast({ type: 'error', title: 'Batch Failed', message: result.message })
        }
      } else {
        const result = await api.payments.batch(selectedSettlements, 'USDC')
        addToast({ type: 'success', title: 'Batch Complete', message: `Processed: ${result.processed}, Failed: ${result.failed}` })
      }
      setSelectedSettlements([])
      setShowBatchModal(false)
      loadData()
    } catch (err) {
      addToast({ type: 'error', title: 'Error', message: err instanceof Error ? err.message : 'Batch processing failed' })
    } finally {
      setBatchProcessing(false)
    }
  }

  function toggleSettlementSelection(nodeId: string) {
    setSelectedSettlements(prev =>
      prev.includes(nodeId)
        ? prev.filter(id => id !== nodeId)
        : [...prev, nodeId]
    )
  }

  function selectAllPending() {
    setSelectedSettlements(pendingSettlements.map(s => s.nodeId))
  }

  async function handleVerify(txHash: string) {
    setVerifying(txHash)
    try {
      const result = await api.payments.verify(txHash)
      addToast({ type: 'info', title: 'Verification Result', message: `Status: ${result.status} | Confirmations: ${result.confirmations}` })
      loadData()
    } catch (err) {
      addToast({ type: 'error', title: 'Verification Failed', message: err instanceof Error ? err.message : 'Verification failed' })
    } finally {
      setVerifying(null)
    }
  }

  const getStatusBadge = (status: string, isDevMode: boolean) => {
    if (isDevMode) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium bg-warning/10 text-warning border border-warning/20 rounded-lg">
          <span className="w-1.5 h-1.5 rounded-full bg-warning" />
          DEV
        </span>
      )
    }
    const styles: Record<string, string> = {
      PENDING: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
      CONFIRMED: 'bg-accent/10 text-accent border-accent/20',
      FAILED: 'bg-error/10 text-error border-error/20',
    }
    const dotColors: Record<string, string> = {
      PENDING: 'bg-yellow-400',
      CONFIRMED: 'bg-accent',
      FAILED: 'bg-error',
    }
    return (
      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium border rounded-lg ${styles[status] || 'bg-gray-500/10 text-gray-400 border-gray-500/20'}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${dotColors[status] || 'bg-gray-400'}`} />
        {status}
      </span>
    )
  }

  const totalPendingAmount = pendingSettlements.reduce((sum, s) => sum + s.amount, 0)

  return (
    <div className="space-y-8 animate-fadeIn">
      {/* Hero Section */}
      <div className="relative py-8 md:py-12">
        {/* Background gradient */}
        <div className="absolute inset-0 bg-gradient-to-b from-purple-500/5 via-transparent to-transparent rounded-3xl" />

        <div className="relative text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-purple-500/5 border border-purple-500/20 rounded-full mb-6 animate-slideUp">
            <CreditCardIcon className="w-4 h-4 text-purple-400" />
            <span className="text-xs text-purple-400 font-medium uppercase tracking-wider">Payment Processing</span>
          </div>

          <h1 className="text-3xl md:text-5xl font-bold text-text-primary mb-3">
            Payments
          </h1>
          <p className="text-text-muted max-w-xl mx-auto">
            Track payment transactions, process settlements, and verify on-chain payments.
          </p>
        </div>
      </div>

      {/* Actions Bar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <Button onClick={loadData} variant="outline" size="sm" icon={<RefreshIcon />}>
          Refresh
        </Button>
        <Button onClick={handleExportCSV} variant="outline" size="sm" icon={<DownloadIcon />}>
          Export CSV
        </Button>
      </div>

      {/* Stats Grid */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <StatCard
            label="Total Payments"
            value={stats.stats.total}
            variant="purple"
            animate
            icon={<ReceiptIcon />}
          />
          <StatCard
            label="Confirmed"
            value={stats.stats.confirmed}
            variant="accent"
            animate
            icon={<CheckCircleIcon />}
          />
          <StatCard
            label="Failed"
            value={stats.stats.failed}
            variant="orange"
            animate
            icon={<XCircleIcon />}
          />
          <StatCard
            label="Dev Mode"
            value={stats.stats.devModePayments}
            animate
            icon={<CodeIcon />}
          />
          <StatCard
            label="Total Paid"
            value={`$${stats.stats.totalAmountPaid.toFixed(2)}`}
            variant="accent"
            animate
            icon={<DollarIcon />}
          />
          {walletBalance && (
            <StatCard
              label="Wallet Balance"
              value={`$${walletBalance.usdc.toFixed(2)}`}
              variant="blue"
              animate
              icon={<WalletIcon />}
              trend={{ value: walletBalance.sol, isPositive: true }}
            />
          )}
        </div>
      )}

      {/* Mode Banner */}
      {stats && (
        <div className={`p-4 rounded-2xl border flex items-center gap-4 ${
          stats.currentMode === 'dev'
            ? 'bg-gradient-to-r from-warning/10 to-orange-500/5 border-warning/30'
            : 'bg-gradient-to-r from-accent/10 to-emerald-500/5 border-accent/30'
        }`}>
          <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${
            stats.currentMode === 'dev' ? 'bg-warning/20' : 'bg-accent/20'
          }`}>
            {stats.currentMode === 'dev' ? (
              <CodeIcon className="w-6 h-6 text-warning" />
            ) : (
              <CheckShieldIcon className="w-6 h-6 text-accent" />
            )}
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <span className={`px-3 py-1 rounded-full text-sm font-bold ${
                stats.currentMode === 'dev'
                  ? 'bg-warning/20 text-warning'
                  : 'bg-accent/20 text-accent'
              }`}>
                {stats.currentMode.toUpperCase()} MODE
              </span>
            </div>
            <p className="text-sm text-text-secondary mt-1">{stats.modeDescription}</p>
          </div>
        </div>
      )}

      {/* Pending Settlements */}
      {pendingSettlements.length > 0 && (
        <Card variant="glass" hover={false}>
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-warning to-orange-400 flex items-center justify-center">
                <ClockIcon className="w-5 h-5 text-white" />
              </div>
              <div>
                <h3 className="font-semibold text-text-primary">Pending Settlements</h3>
                <p className="text-xs text-text-muted">{pendingSettlements.length} settlements • ${totalPendingAmount.toFixed(2)} total</p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button onClick={selectAllPending} variant="ghost" size="sm">
                Select All
              </Button>
              <Button
                onClick={() => setShowBatchModal(true)}
                disabled={selectedSettlements.length === 0}
                variant="primary"
                size="sm"
              >
                Process ({selectedSettlements.length})
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            {pendingSettlements.map((settlement) => (
              <div
                key={settlement.nodeId}
                onClick={() => toggleSettlementSelection(settlement.nodeId)}
                className={`flex items-center gap-4 p-4 rounded-xl border cursor-pointer transition-all ${
                  selectedSettlements.includes(settlement.nodeId)
                    ? 'bg-accent/5 border-accent/30 shadow-[0_0_0_1px_rgba(34,197,94,0.2)]'
                    : 'bg-background/50 border-border/50 hover:border-accent/30'
                }`}
              >
                <input
                  type="checkbox"
                  checked={selectedSettlements.includes(settlement.nodeId)}
                  onChange={() => toggleSettlementSelection(settlement.nodeId)}
                  className="w-4 h-4 rounded border-border accent-accent"
                />
                <div className="flex-1">
                  <p className="text-sm font-medium text-text-primary">
                    <Link href={`/nodes/${settlement.nodeId}`} className="hover:text-accent" onClick={(e) => e.stopPropagation()}>
                      Node: {settlement.nodeId.substring(0, 12)}...
                    </Link>
                  </p>
                  <p className="text-xs text-text-muted font-mono">{settlement.walletAddress.substring(0, 20)}...</p>
                </div>
                <div className="text-right">
                  <p className="font-semibold text-accent">${settlement.amount.toFixed(2)}</p>
                  <p className="text-xs text-text-muted">{settlement.jobCount} jobs</p>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Filter and Search */}
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="flex gap-1 p-1 bg-surface rounded-xl">
          {['all', 'PENDING', 'CONFIRMED', 'FAILED'].map((status) => (
            <button
              key={status}
              onClick={() => {
                setFilter(status)
                setPage(1)
              }}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-all ${
                filter === status
                  ? 'bg-accent text-white shadow-lg shadow-accent/20'
                  : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
              }`}
            >
              {status === 'all' ? 'All' : status}
            </button>
          ))}
        </div>
        <div className="flex-1 max-w-md relative">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by address, tx hash, or ID..."
            className="w-full pl-10 pr-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent"
          />
        </div>
      </div>

      {/* Payments Table */}
      <Card variant="glass" hover={false}>
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-purple-400 flex items-center justify-center">
            <ListIcon className="w-5 h-5 text-white" />
          </div>
          <div>
            <h3 className="font-semibold text-text-primary">Payment History</h3>
            <p className="text-xs text-text-muted">{pagination?.total ?? 0} total payments</p>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase tracking-wider">ID</th>
                <th className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase tracking-wider">Amount</th>
                <th className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase tracking-wider">Recipient</th>
                <th className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase tracking-wider">Tx Hash</th>
                <th className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase tracking-wider">Status</th>
                <th className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase tracking-wider">Created</th>
                <th className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center">
                    <div className="flex flex-col items-center gap-3">
                      <div className="w-8 h-8 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
                      <p className="text-text-muted">Loading payments...</p>
                    </div>
                  </td>
                </tr>
              ) : filteredPayments.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12">
                    <EmptyState
                      icon={<ReceiptIcon className="w-8 h-8" />}
                      title={search ? 'No payments match your search' : 'No payments found'}
                      description={search ? 'Try adjusting your search terms' : 'Payment records will appear here once settlements are processed'}
                    />
                  </td>
                </tr>
              ) : (
                filteredPayments.map((payment) => (
                  <tr key={payment.id} className="border-b border-border/50 hover:bg-surface-hover/50 transition-colors">
                    <td className="py-4 px-4">
                      <span className="text-xs font-mono text-text-secondary bg-surface-hover px-2 py-1 rounded">{payment.id.substring(0, 12)}...</span>
                    </td>
                    <td className="py-4 px-4">
                      <span className="font-semibold text-text-primary">${payment.amount.toFixed(2)}</span>
                      <span className="text-xs text-text-muted ml-1">{payment.currency}</span>
                    </td>
                    <td className="py-4 px-4">
                      <span className="text-xs font-mono text-text-secondary">
                        {payment.recipientAddress.substring(0, 8)}...{payment.recipientAddress.slice(-4)}
                      </span>
                    </td>
                    <td className="py-4 px-4">
                      {payment.txHash ? (
                        <a
                          href={`https://solscan.io/tx/${payment.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs font-mono text-accent hover:underline flex items-center gap-1"
                        >
                          {payment.txHash.substring(0, 12)}...
                          <ExternalLinkIcon className="w-3 h-3" />
                        </a>
                      ) : (
                        <span className="text-xs text-text-muted">-</span>
                      )}
                    </td>
                    <td className="py-4 px-4">{getStatusBadge(payment.status, payment.isDevMode)}</td>
                    <td className="py-4 px-4">
                      <span className="text-xs text-text-muted">
                        {new Date(payment.createdAt).toLocaleDateString()}
                      </span>
                    </td>
                    <td className="py-4 px-4">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/settlements/${payment.settlementId}`}
                          className="px-3 py-1.5 text-xs bg-surface-hover text-text-secondary rounded-lg hover:bg-border transition-colors"
                        >
                          View
                        </Link>
                        {payment.txHash && !payment.isDevMode && (
                          <button
                            onClick={() => handleVerify(payment.txHash!)}
                            disabled={verifying === payment.txHash}
                            className="px-3 py-1.5 text-xs bg-accent/10 text-accent rounded-lg hover:bg-accent/20 disabled:opacity-50"
                          >
                            {verifying === payment.txHash ? 'Verifying...' : 'Verify'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {pagination && pagination.totalPages > 1 && (
          <div className="flex items-center justify-between p-4 border-t border-border">
            <p className="text-sm text-text-muted">
              Showing {((page - 1) * pagination.limit) + 1} to {Math.min(page * pagination.limit, pagination.total)} of {pagination.total}
            </p>
            <div className="flex gap-2">
              <Button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                variant="outline"
                size="sm"
              >
                Previous
              </Button>
              <span className="px-4 py-2 text-sm text-text-muted">
                {page} / {pagination.totalPages}
              </span>
              <Button
                onClick={() => setPage(p => Math.min(pagination.totalPages, p + 1))}
                disabled={page === pagination.totalPages}
                variant="outline"
                size="sm"
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* Batch Processing Modal */}
      <ConfirmModal
        isOpen={showBatchModal}
        onClose={() => setShowBatchModal(false)}
        onConfirm={handleBatchProcess}
        title="Batch Process Payments"
        message={`Process ${selectedSettlements.length} settlement(s)${selectedSettlements.length <= 15 && useOnchainBatch ? ' in a single on-chain transaction' : ' sequentially'}. ${stats?.currentMode === 'dev' ? 'Payments will be simulated in DEV mode.' : 'Real funds will be transferred.'}`}
        confirmText={batchProcessing ? 'Processing...' : `Process ${selectedSettlements.length} Payments`}
        variant={stats?.currentMode === 'dev' ? 'warning' : 'default'}
        loading={batchProcessing}
      />

      {/* On-chain Batch Toggle */}
      {showBatchModal && selectedSettlements.length <= 15 && (
        <div className="fixed inset-0 z-40 flex items-center justify-center pointer-events-none">
          <div className="absolute bottom-32 bg-surface border border-border rounded-xl p-4 shadow-xl pointer-events-auto">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={useOnchainBatch}
                onChange={(e) => setUseOnchainBatch(e.target.checked)}
                className="w-4 h-4 rounded border-border accent-accent"
              />
              <div>
                <span className="text-sm font-medium text-text-primary">Single on-chain transaction</span>
                <p className="text-xs text-text-muted">Saves gas fees by batching payments</p>
              </div>
            </label>
          </div>
        </div>
      )}
    </div>
  )
}

// =============================================================================
// ICONS
// =============================================================================

function CreditCardIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
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

function DownloadIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
    </svg>
  )
}

function ReceiptIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" />
    </svg>
  )
}

function CheckCircleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function XCircleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function CodeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
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

function WalletIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
    </svg>
  )
}

function CheckShieldIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
    </svg>
  )
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
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

function ExternalLinkIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
    </svg>
  )
}
