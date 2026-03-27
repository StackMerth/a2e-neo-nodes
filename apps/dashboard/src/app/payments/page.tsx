'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Card } from '@/components/ui/Card'
import { ConfirmModal } from '@/components/ui/Modal'
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

export default function PaymentsPage() {
  const [payments, setPayments] = useState<Payment[]>([])
  const [stats, setStats] = useState<PaymentStats | null>(null)
  const [pendingSettlements, setPendingSettlements] = useState<PendingSettlement[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<string>('all')
  const [verifying, setVerifying] = useState<string | null>(null)
  const [selectedSettlements, setSelectedSettlements] = useState<string[]>([])
  const [batchProcessing, setBatchProcessing] = useState(false)
  const [showBatchModal, setShowBatchModal] = useState(false)

  useEffect(() => {
    loadData()
  }, [filter])

  async function loadData() {
    setLoading(true)
    try {
      const [paymentsRes, statsRes, pendingRes] = await Promise.all([
        api.payments.list({ status: filter !== 'all' ? filter : undefined, limit: 50 }),
        api.payments.stats(),
        api.settlements.pending(),
      ])
      setPayments(paymentsRes.payments)
      setStats(statsRes)
      setPendingSettlements(pendingRes.pending)
    } catch (err) {
      console.error('Failed to load payments:', err)
    } finally {
      setLoading(false)
    }
  }

  async function handleBatchProcess() {
    if (selectedSettlements.length === 0) return
    setBatchProcessing(true)
    try {
      const result = await api.payments.batch(selectedSettlements, 'USDC')
      alert(`Batch complete:\nProcessed: ${result.processed}\nFailed: ${result.failed}`)
      setSelectedSettlements([])
      setShowBatchModal(false)
      loadData()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Batch processing failed')
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
      alert(`Verification: ${result.status}\nConfirmations: ${result.confirmations}`)
      loadData()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Verification failed')
    } finally {
      setVerifying(null)
    }
  }

  const getStatusBadge = (status: string, isDevMode: boolean) => {
    if (isDevMode) {
      return <span className="px-2 py-0.5 text-xs font-medium bg-warning/20 text-warning rounded">DEV</span>
    }
    const colors: Record<string, string> = {
      PENDING: 'bg-yellow-500/20 text-yellow-400',
      CONFIRMED: 'bg-accent/20 text-accent',
      FAILED: 'bg-error/20 text-error',
    }
    return <span className={`px-2 py-0.5 text-xs font-medium rounded ${colors[status] || 'bg-gray-500/20 text-gray-400'}`}>{status}</span>
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Payments</h1>
          <p className="text-text-muted mt-1">Track and verify payment transactions</p>
        </div>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <Card className="p-4">
            <p className="text-xs text-text-muted uppercase">Total Payments</p>
            <p className="text-2xl font-bold text-text-primary mt-1">{stats.stats.total}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-text-muted uppercase">Confirmed</p>
            <p className="text-2xl font-bold text-accent mt-1">{stats.stats.confirmed}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-text-muted uppercase">Failed</p>
            <p className="text-2xl font-bold text-error mt-1">{stats.stats.failed}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-text-muted uppercase">Dev Mode</p>
            <p className="text-2xl font-bold text-warning mt-1">{stats.stats.devModePayments}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-text-muted uppercase">Total Paid</p>
            <p className="text-2xl font-bold text-text-primary mt-1">${stats.stats.totalAmountPaid.toFixed(2)}</p>
          </Card>
        </div>
      )}

      {/* Mode Banner */}
      {stats && (
        <div className={`p-4 rounded-lg border ${stats.currentMode === 'dev' ? 'bg-warning/10 border-warning/30' : 'bg-accent/10 border-accent/30'}`}>
          <div className="flex items-center gap-3">
            <span className={`px-3 py-1 rounded-full text-sm font-bold ${stats.currentMode === 'dev' ? 'bg-warning/20 text-warning' : 'bg-accent/20 text-accent'}`}>
              {stats.currentMode.toUpperCase()} MODE
            </span>
            <span className="text-sm text-text-secondary">{stats.modeDescription}</span>
          </div>
        </div>
      )}

      {/* Pending Settlements - Batch Processing */}
      {pendingSettlements.length > 0 && (
        <Card className="p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold text-text-primary">Pending Settlements</h3>
              <p className="text-sm text-text-muted">{pendingSettlements.length} settlements awaiting payment</p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={selectAllPending}
                className="px-3 py-1.5 text-xs bg-surface-hover hover:bg-accent/10 rounded-lg transition-colors"
              >
                Select All
              </button>
              <button
                onClick={() => setShowBatchModal(true)}
                disabled={selectedSettlements.length === 0}
                className="px-4 py-1.5 text-xs bg-accent text-white rounded-lg hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Process Selected ({selectedSettlements.length})
              </button>
            </div>
          </div>

          <div className="space-y-2">
            {pendingSettlements.map((settlement) => (
              <div
                key={settlement.nodeId}
                className={`flex items-center gap-4 p-3 rounded-lg border transition-colors cursor-pointer ${
                  selectedSettlements.includes(settlement.nodeId)
                    ? 'bg-accent/10 border-accent/30'
                    : 'bg-surface-hover border-border hover:border-accent/30'
                }`}
                onClick={() => toggleSettlementSelection(settlement.nodeId)}
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
                  <p className="font-medium text-accent">${settlement.amount.toFixed(2)}</p>
                  <p className="text-xs text-text-muted">{settlement.jobCount} jobs</p>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Filter */}
      <div className="flex gap-2">
        {['all', 'PENDING', 'CONFIRMED', 'FAILED'].map((status) => (
          <button
            key={status}
            onClick={() => setFilter(status)}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              filter === status
                ? 'bg-accent text-white'
                : 'bg-surface-hover text-text-secondary hover:text-text-primary'
            }`}
          >
            {status === 'all' ? 'All' : status}
          </button>
        ))}
      </div>

      {/* Payments Table */}
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase">ID</th>
                <th className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase">Amount</th>
                <th className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase">Recipient</th>
                <th className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase">Tx Hash</th>
                <th className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase">Status</th>
                <th className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase">Created</th>
                <th className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-text-muted">Loading...</td>
                </tr>
              ) : payments.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-text-muted">No payments found</td>
                </tr>
              ) : (
                payments.map((payment) => (
                  <tr key={payment.id} className="border-b border-border/50 hover:bg-surface-hover/50">
                    <td className="py-3 px-4">
                      <span className="text-xs font-mono text-text-secondary">{payment.id.substring(0, 12)}...</span>
                    </td>
                    <td className="py-3 px-4">
                      <span className="font-medium text-text-primary">${payment.amount.toFixed(2)}</span>
                      <span className="text-xs text-text-muted ml-1">{payment.currency}</span>
                    </td>
                    <td className="py-3 px-4">
                      <span className="text-xs font-mono text-text-secondary">
                        {payment.recipientAddress.substring(0, 8)}...{payment.recipientAddress.substring(-4)}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      {payment.txHash ? (
                        <a
                          href={`https://solscan.io/tx/${payment.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs font-mono text-accent hover:underline"
                        >
                          {payment.txHash.substring(0, 12)}...
                        </a>
                      ) : (
                        <span className="text-xs text-text-muted">-</span>
                      )}
                    </td>
                    <td className="py-3 px-4">{getStatusBadge(payment.status, payment.isDevMode)}</td>
                    <td className="py-3 px-4">
                      <span className="text-xs text-text-muted">
                        {new Date(payment.createdAt).toLocaleDateString()}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      {payment.txHash && !payment.isDevMode && (
                        <button
                          onClick={() => handleVerify(payment.txHash!)}
                          disabled={verifying === payment.txHash}
                          className="px-2 py-1 text-xs bg-accent/10 text-accent rounded hover:bg-accent/20 disabled:opacity-50"
                        >
                          {verifying === payment.txHash ? 'Verifying...' : 'Verify'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Batch Processing Modal */}
      <ConfirmModal
        isOpen={showBatchModal}
        onClose={() => setShowBatchModal(false)}
        onConfirm={handleBatchProcess}
        title="Batch Process Payments"
        message={`You are about to process ${selectedSettlements.length} settlements. ${stats?.currentMode === 'dev' ? 'Payments will be simulated in DEV mode.' : 'Real funds will be transferred.'}`}
        confirmText={batchProcessing ? 'Processing...' : `Process ${selectedSettlements.length} Payments`}
        variant={stats?.currentMode === 'dev' ? 'warning' : 'default'}
        loading={batchProcessing}
      />
    </div>
  )
}
