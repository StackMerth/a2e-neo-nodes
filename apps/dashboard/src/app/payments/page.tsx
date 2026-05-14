'use client'

import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import {
  CreditCard, CircleCheck, ExternalLink, Download, Receipt,
  XCircle, Code, ShieldCheck, Clock, Search, List,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { ConfirmModal } from '@/components/ui/Modal'
import { useToast } from '@/components/ui/Toast'
import { api } from '@/lib/api'
import {
  DashboardShell,
  MetricTriad,
  SectionCard,
  DataTableCard,
  type DataTableColumn,
  type MetricCardData,
} from '@/components/dashboard/FuturisticShell'

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

type PaymentRow = Payment & Record<string, unknown>

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
  const [, setWalletBalance] = useState<{ sol: number; usdc: number; isDevMode: boolean } | null>(null)

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
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium bg-warning/10 text-warning border border-warning/20 rounded">
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
      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium border rounded ${styles[status] || 'bg-gray-500/10 text-gray-400 border-gray-500/20'}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${dotColors[status] || 'bg-gray-400'}`} />
        {status}
      </span>
    )
  }

  const totalPendingAmount = pendingSettlements.reduce((sum, s) => sum + s.amount, 0)
  const pendingPaymentsCount = stats ? (stats.stats.total - stats.stats.confirmed - stats.stats.failed) : 0

  const metrics: MetricCardData[] = [
    { label: 'Total Payments', value: stats?.stats.total ?? 0, icon: Receipt, tone: 'green' },
    { label: 'Pending', value: pendingPaymentsCount, icon: Clock, tone: 'blue' },
    { label: 'Completed', value: stats?.stats.confirmed ?? 0, icon: CircleCheck, tone: 'green' },
  ]

  const columns: Array<DataTableColumn<PaymentRow>> = [
    {
      key: 'id',
      header: 'ID',
      mono: true,
      render: (p) => (
        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          {p.id.substring(0, 12)}...
        </span>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      mono: true,
      render: (p) => (
        <span>
          ${p.amount.toFixed(2)}
          <span className="ml-1" style={{ color: 'var(--text-muted)' }}>{p.currency}</span>
        </span>
      ),
    },
    {
      key: 'recipientAddress',
      header: 'Recipient',
      mono: true,
      render: (p) => (
        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          {p.recipientAddress.substring(0, 8)}...{p.recipientAddress.slice(-4)}
        </span>
      ),
    },
    {
      key: 'txHash',
      header: 'Tx Hash',
      mono: true,
      render: (p) =>
        p.txHash ? (
          <a
            href={`https://solscan.io/tx/${p.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs hover:underline flex items-center gap-1"
            style={{ color: 'var(--primary)' }}
          >
            {p.txHash.substring(0, 12)}...
            <ExternalLink className="w-3 h-3" />
          </a>
        ) : (
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>-</span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (p) => getStatusBadge(p.status, p.isDevMode),
    },
    {
      key: 'createdAt',
      header: 'Created',
      mono: true,
      render: (p) => (
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {new Date(p.createdAt).toLocaleDateString()}
        </span>
      ),
    },
    {
      key: 'settlementId',
      header: 'Actions',
      align: 'right',
      render: (p) => (
        <div className="flex items-center justify-end gap-2">
          <Link
            href={`/settlements/${p.settlementId}`}
            className="px-3 py-1 text-xs rounded-md transition-colors"
            style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}
          >
            View
          </Link>
          {p.txHash && !p.isDevMode && (
            <button
              onClick={() => handleVerify(p.txHash!)}
              disabled={verifying === p.txHash}
              className="px-3 py-1 text-xs bg-accent/10 text-accent rounded-md hover:bg-accent/20 disabled:opacity-50"
            >
              {verifying === p.txHash ? 'Verifying...' : 'Verify'}
            </button>
          )}
        </div>
      ),
    },
  ]

  const filterPills = (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="flex gap-1 p-1 rounded-md" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }}>
        {['all', 'PENDING', 'CONFIRMED', 'FAILED'].map((status) => {
          const isActive = filter === status
          return (
            <button
              key={status}
              onClick={() => { setFilter(status); setPage(1) }}
              className="px-3 py-1 text-xs font-medium rounded transition-colors"
              style={isActive
                ? { background: 'var(--primary)', color: '#fff' }
                : { color: 'var(--text-secondary)' }
              }
            >
              {status === 'all' ? 'All' : status}
            </button>
          )
        })}
      </div>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search..."
          className="pl-9 pr-3 py-1.5 text-xs rounded-md w-48 focus:outline-none"
          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}
        />
      </div>
      <Button onClick={handleExportCSV} variant="outline" size="sm" icon={<Download className="w-3.5 h-3.5" />}>
        Export
      </Button>
    </div>
  )

  return (
    <DashboardShell
      title="Payments"
      subtitle={pagination ? `${pagination.total} total payments` : `${payments.length} payments`}
      onRefresh={loadData}
      refreshing={loading}
    >
      <div className="lg:col-span-3 space-y-6">
        <MetricTriad metrics={metrics} />

        {/* Mode Banner */}
        {stats && (
          <div
            className="p-4 rounded-md flex items-center gap-4"
            style={{
              background: stats.currentMode === 'dev' ? 'rgba(245,158,11,0.08)' : 'rgba(34,197,94,0.08)',
              border: `1px solid ${stats.currentMode === 'dev' ? 'rgba(245,158,11,0.3)' : 'rgba(34,197,94,0.3)'}`,
            }}
          >
            <div
              className="w-10 h-10 rounded-md flex items-center justify-center"
              style={{ background: stats.currentMode === 'dev' ? 'rgba(245,158,11,0.2)' : 'rgba(34,197,94,0.2)' }}
            >
              {stats.currentMode === 'dev' ? (
                <Code className="w-5 h-5 text-warning" />
              ) : (
                <ShieldCheck className="w-5 h-5 text-accent" />
              )}
            </div>
            <div className="flex-1">
              <span
                className="px-2.5 py-0.5 rounded text-xs font-bold"
                style={{
                  background: stats.currentMode === 'dev' ? 'rgba(245,158,11,0.2)' : 'rgba(34,197,94,0.2)',
                  color: stats.currentMode === 'dev' ? 'var(--warning)' : 'var(--success)',
                }}
              >
                {stats.currentMode.toUpperCase()} MODE
              </span>
              <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{stats.modeDescription}</p>
            </div>
          </div>
        )}

        {/* Pending Settlements */}
        {pendingSettlements.length > 0 && (
          <SectionCard
            title="Pending Settlements"
            icon={Clock}
            badge={
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                ({pendingSettlements.length} settlements, ${totalPendingAmount.toFixed(2)} total)
              </span>
            }
            actions={
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
            }
          >
            <div className="space-y-2">
              {pendingSettlements.map((settlement) => (
                <div
                  key={settlement.nodeId}
                  onClick={() => toggleSettlementSelection(settlement.nodeId)}
                  className="flex items-center gap-4 p-3 rounded-md border cursor-pointer transition-all"
                  style={selectedSettlements.includes(settlement.nodeId)
                    ? { background: 'rgba(34,197,94,0.05)', borderColor: 'rgba(34,197,94,0.3)' }
                    : { background: 'var(--bg-elevated)', borderColor: 'var(--border-color)' }
                  }
                >
                  <input
                    type="checkbox"
                    checked={selectedSettlements.includes(settlement.nodeId)}
                    onChange={() => toggleSettlementSelection(settlement.nodeId)}
                    className="w-4 h-4 rounded border-border accent-accent"
                  />
                  <div className="flex-1">
                    <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                      <Link
                        href={`/nodes/${settlement.nodeId}`}
                        className="hover:text-accent"
                        onClick={(e) => e.stopPropagation()}
                      >
                        Node: {settlement.nodeId.substring(0, 12)}...
                      </Link>
                    </p>
                    <p className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                      {settlement.walletAddress.substring(0, 20)}...
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold" style={{ color: 'var(--primary)' }}>${settlement.amount.toFixed(2)}</p>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{settlement.jobCount} jobs</p>
                  </div>
                </div>
              ))}
            </div>
          </SectionCard>
        )}

        <DataTableCard<PaymentRow>
          title="Payment History"
          icon={List}
          actions={filterPills}
          columns={columns}
          rows={filteredPayments as PaymentRow[]}
          loading={loading && payments.length === 0}
          empty={
            <div className="text-center py-8">
              <Receipt className="w-8 h-8 mx-auto mb-2" style={{ color: 'var(--text-muted)' }} />
              <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                {search ? 'No payments match your search' : 'No payments found'}
              </p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                {search ? 'Try adjusting your search terms' : 'Payment records will appear here once settlements are processed'}
              </p>
            </div>
          }
          pagination={pagination ? {
            page,
            pageSize: pagination.limit,
            total: pagination.total,
            onPageChange: setPage,
          } : undefined}
        />
      </div>

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
          <div
            className="absolute bottom-32 rounded-md p-4 pointer-events-auto"
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }}
          >
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={useOnchainBatch}
                onChange={(e) => setUseOnchainBatch(e.target.checked)}
                className="w-4 h-4 rounded border-border accent-accent"
              />
              <div>
                <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                  Single on-chain transaction
                </span>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Saves gas fees by batching payments
                </p>
              </div>
            </label>
          </div>
        </div>
      )}
    </DashboardShell>
  )
}
